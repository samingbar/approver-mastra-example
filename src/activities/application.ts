import { ApplicationFailure, Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import {
  extractionArtifactSchema, ocrManifestSchema, fieldNames,
  type ArtifactRef, type EvidenceValidation, type PolicySnapshot,
} from '../contracts.js';
import { validateEvidence } from '../evidence.js';
import { evaluatePolicy } from '../policy.js';
import { findFixtureByDocumentHash } from '../fixtures/index.js';
import { ArtifactStore, PgStore, hashBytes, canonicalJson, type ApplicationPatch, type AuditEventInput, type FinalCommitInput, type OpenReviewCaseInput } from '../storage.js';
import type { ReviewCommand } from '../workflows/application-contract.js';
import { reviewContentSchema } from '../workflows/application-contract.js';

export interface CompactEvidence { facts: EvidenceValidation['facts']; issues: EvidenceValidation['issues'] }
export interface ProgressInput extends ApplicationPatch { applicationId: string; workflowId: string; workflowRunId: string }
export interface ReviewInput {
  applicationId: string; command: ReviewCommand; extractionRef: ArtifactRef;
  manifestRef: ArtifactRef; evidenceRevision: number; policy: PolicySnapshot;
}

export function createApplicationActivities(db: PgStore, artifacts: ArtifactStore) {
  async function checkedReviewContent(ref: ArtifactRef, applicationId: string, commandId: string) {
    if (!ref.key.startsWith(`reviews/${applicationId}/${commandId}/`) || ref.contentType !== 'application/json' || ref.size > 512 * 1024) {
      throw ApplicationFailure.nonRetryable('Review content binding is invalid', 'REVIEW_CONTENT_INVALID');
    }
    const bytes = await artifacts.getBytes(ref.key);
    if (bytes.length !== ref.size || hashBytes(bytes) !== ref.sha256) throw ApplicationFailure.nonRetryable('Review content hash mismatch', 'ARTIFACT_INTEGRITY_ERROR');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw ApplicationFailure.nonRetryable('Review content JSON is invalid', 'REVIEW_CONTENT_INVALID'); }
    const parsed = reviewContentSchema.safeParse(value);
    if (!parsed.success || parsed.data.applicationId !== applicationId || parsed.data.commandId !== commandId) {
      throw ApplicationFailure.nonRetryable('Review content schema or binding is invalid', 'REVIEW_CONTENT_INVALID');
    }
    return parsed.data;
  }
  async function checkedArtifact(ref: ArtifactRef) {
    const bytes = await artifacts.getBytes(ref.key);
    if (hashBytes(bytes) !== ref.sha256) throw ApplicationFailure.nonRetryable('Artifact hash mismatch', 'ARTIFACT_INTEGRITY_ERROR');
    return extractionArtifactSchema.parse(JSON.parse(bytes.toString('utf8')));
  }
  async function persistProgress(input: ProgressInput): Promise<void> {
    const { applicationId, workflowId: _workflowId, ...patch } = input;
    await db.updateApplication(applicationId, patch);
  }
  async function applicationEvent(input: AuditEventInput): Promise<void> {
    const childId = input.payload?.childWorkflowId;
    if (typeof childId !== 'string') { await db.recordEvent(input); return; }
    // This Node activity records observable child execution metadata for the
    // durable audit. Clients never enter either replay-safe workflow bundle.
    const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
    try {
      const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
      const child = client.workflow.getHandle(childId);
      const description = await child.describe();
      const history = await child.fetchHistory();
      const scheduled = new Map<string, string>();
      const activities: { type: string; attempt: number }[] = [];
      for (const event of history.events ?? []) {
        if (event.activityTaskScheduledEventAttributes) scheduled.set(String(event.eventId), event.activityTaskScheduledEventAttributes.activityType?.name ?? 'unknown');
        if (event.activityTaskStartedEventAttributes) activities.push({
          type: scheduled.get(String(event.activityTaskStartedEventAttributes.scheduledEventId)) ?? 'unknown',
          attempt: event.activityTaskStartedEventAttributes.attempt ?? 1,
        });
      }
      const payload = { ...input.payload, childWorkflowId: childId, childRunId: description.runId, activities };
      await db.recordEvent({ ...input, payload });
      if (activities.some(activity => activity.attempt > 1)) await db.recordEvent({
        applicationId: input.applicationId, eventId: `${input.eventId}:recovery`, type: 'TECHNICAL_RECOVERY',
        payload: { childWorkflowId: childId, childRunId: description.runId, activities,
          summary: 'Unfinished activities retried from durable Temporal history; completed artifacts retained.' },
      });
    } finally { await connection.close(); }
  }
  async function loadCompactEvidence(ref: ArtifactRef): Promise<CompactEvidence> {
    const artifact = await checkedArtifact(ref);
    return { facts: artifact.result.facts, issues: compactIssues(artifact.result.issues) };
  }
  async function openApplicationReview(input: OpenReviewCaseInput): Promise<void> { await db.openReviewCase(input); }
  async function markApplicationOverdue(id: string): Promise<void> { await db.markReviewOverdue(id, `${id}:overdue`); }
  async function commitApplication(input: FinalCommitInput): Promise<FinalCommitInput['status']> {
    let finalInput = input;
    if (input.payload?.contentRef && typeof input.payload.commandId === 'string') {
      const ref = input.payload.contentRef as ArtifactRef;
      const content = await checkedReviewContent(ref, input.applicationId, input.payload.commandId);
      finalInput = { ...input, artifactRefs: [...(input.artifactRefs ?? []), ref], payload: { ...input.payload, note: content.note } };
    }
    const persisted = await db.commitFinal(finalInput);
    const pause = input.payload?.simulateFinalAckPauseMs;
    if (input.status !== 'CANCELLED' && input.payload?.mode === 'fixture' && typeof pause === 'number' && pause > 0 && pause <= 10_000 && Context.current().info.attempt === 1) {
      const deadline = Date.now() + pause;
      while (Date.now() < deadline) {
        Context.current().heartbeat({ stage: 'committed-final-acknowledgement-pause' });
        await Context.current().sleep(Math.min(1_000, deadline - Date.now()));
      }
    }
    if (input.payload?.mode === 'fixture' && input.payload.simulateLostFinalAck === true && Context.current().info.attempt === 1) {
      throw ApplicationFailure.retryable('Fixture: final commit acknowledgement lost after transaction', 'COMMIT_ACK_LOST');
    }
    return persisted.status as FinalCommitInput['status'];
  }
  async function applyReview(input: ReviewInput) {
    const { command } = input;
    const content = await checkedReviewContent(command.contentRef, input.applicationId, command.commandId);
    if (content.action !== command.action) throw ApplicationFailure.nonRetryable('Review content action binding is invalid', 'REVIEW_CONTENT_INVALID');
    const prior = await checkedArtifact(input.extractionRef);
    let updated = prior;
    let extractionRef: ArtifactRef | undefined;
    if (command.action === 'CORRECT' || command.action === 'VERIFY') {
      const manifestBytes = await artifacts.getBytes(input.manifestRef.key);
      if (hashBytes(manifestBytes) !== input.manifestRef.sha256) throw ApplicationFailure.nonRetryable('OCR artifact hash mismatch', 'ARTIFACT_INTEGRITY_ERROR');
      const manifest = ocrManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
      const fixture = await findFixtureByDocumentHash(prior.documentHash);
      const raw = content.corrections ?? { fields: prior.result.fields,
        debtExcludesProposedLoan: prior.result.facts.debtExcludesProposedLoan,
        cashPriceExcludesExtras: prior.result.facts.cashPriceExcludesExtras,
        fixedApr: prior.result.facts.fixedApr, notes: [] };
      const verification = prior.verificationRecord ?? (fixture ? {
        documentHash: prior.documentHash, verifiedFields: [...fieldNames], source: 'synthetic-fixture' as const, recordId: fixture.id,
      } : command.action === 'VERIFY' ? {
        documentHash: prior.documentHash, verifiedFields: [...fieldNames], source: 'reviewer-attestation' as const,
        recordId: command.commandId, reviewerId: command.actorId, note: content.note,
      } : undefined);
      const result = validateEvidence(raw, manifest, verification);
      updated = { ...prior, analysisRevision: `${prior.analysisRevision}:review:${input.evidenceRevision + 1}`, result,
        ...(verification ? { verificationRecord: verification } : {}) };
      extractionRef = await artifacts.putJsonImmutable(
        `evidence/${input.applicationId}/revision-${input.evidenceRevision + 1}-${hashBytes(Buffer.from(canonicalJson(updated)))}.json`, updated);
    }
    const policyResult = evaluatePolicy(updated.result.facts, updated.result.issues, input.policy);
    const canFinalize = updated.result.issues.length === 0
      && policyResult.rules.filter(rule => rule.id === 'evidence' || rule.id === 'terms').every(rule => rule.band === 'PASS');
    await db.recordEvent({
      applicationId: input.applicationId, eventId: `${input.applicationId}:review:${command.commandId}`,
      type: command.action === 'OVERRIDE' ? 'REVIEW_OVERRIDE' : command.action === 'CORRECT' ? 'EVIDENCE_CORRECTED' : 'REVIEW_COMMAND',
      actorType: 'reviewer', actorId: command.actorId,
      evidenceRevision: input.evidenceRevision + (extractionRef ? 1 : 0), evidenceHash: extractionRef?.sha256 ?? input.extractionRef.sha256,
      reasonCodes: policyResult.reasonCodes, artifactRefs: [extractionRef ?? input.extractionRef, command.contentRef],
      payload: { commandId: command.commandId, action: command.action, note: content.note, contentRef: command.contentRef, override: command.action === 'OVERRIDE',
        originalFacts: prior.result.facts, correctedFacts: updated.result.facts, decision: policyResult,
        verificationResolution: command.action === 'VERIFY' ? 'reviewer-attestation; provenance is not authenticity' : null },
    });
    return { ...(extractionRef ? { extractionRef } : {}), compact: { facts: updated.result.facts, issues: compactIssues(updated.result.issues) }, canFinalize };
  }
  return { persistProgress, applicationEvent, loadCompactEvidence, openApplicationReview, markApplicationOverdue, commitApplication, applyReview };
}
export type ApplicationActivities = ReturnType<typeof createApplicationActivities>;

function compactIssues(issues: EvidenceValidation['issues']): EvidenceValidation['issues'] {
  return issues.map(({ code, field, message }) => ({ code, ...(field ? { field } : {}), message }));
}
