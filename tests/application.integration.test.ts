import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactRefSchema, extractionArtifactSchema, ocrManifestSchema, policyDecisionSchema, fieldNames } from '../src/contracts.js';
import { loadFixtureManifest, readFixtureBytes, type FixtureManifest } from '../src/fixtures/index.js';
import { ArtifactStore, PgStore, hashBytes, type ApplicationProjection } from '../src/storage.js';
import { DEMO_POLICY } from '../src/policy.js';
import { ANALYSIS_WORKFLOW_TYPE } from '../src/integration/analysis-child-contract.js';
import type { ApplicationInput, ApplicationState } from '../src/workflows/application-contract.js';
import { reviewCommandSchema } from '../src/workflows/application-contract.js';
import { DemoClient } from '../scripts/demo-client.js';

const execute = promisify(execFile);
const api = new DemoClient();
const db = new PgStore();
const artifacts = new ArtifactStore();
const created = new Set<string>();
let connection: Connection;
let temporal: Client;
let manifest: FixtureManifest;

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(200); }
  throw new Error('Timed out waiting for durable application checkpoint');
}

async function upload(fixtureId: string): Promise<ApplicationProjection> {
  const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
  if (!fixture) throw new Error(`Fixture missing: ${fixtureId}`);
  const { applicationId } = await api.upload(fixture);
  created.add(applicationId);
  return await api.waitForApplication(applicationId, 120_000);
}

async function directApplication(fixtureId: string, id: string, extra: Partial<ApplicationInput> = {}) {
  const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
  if (!fixture) throw new Error(`Fixture missing: ${fixtureId}`);
  const document = await artifacts.putImmutable(`documents/${fixture.sha256}.pdf`, await readFixtureBytes(fixtureId), 'application/pdf');
  const workflowId = `loan-${id}`;
  await db.createApplication({ id, documentKey: document.key, documentHash: document.sha256, mode: 'fixture',
    workflowId, policyVersion: DEMO_POLICY.version, policyHash: DEMO_POLICY.hash,
    data: { educationalSimulation: true, sourceVerifiedFixture: true, uploadedBy: 'integration-test' },
  });
  created.add(id);
  const input: ApplicationInput = { applicationId: id, document, documentHash: document.sha256,
    mode: 'fixture', policy: DEMO_POLICY, revision: 1, ...extra };
  const handle = await temporal.workflow.start('loanApplicationWorkflow', { workflowId, taskQueue: 'loan-applications', args: [input] });
  await db.updateApplication(id, { workflowRunId: handle.firstExecutionRunId });
  return handle;
}

describe('actual local API, native parent, generated child, review and durable audit', () => {
  beforeAll(async () => {
    const configuration = await api.request<{ mode: string }>('/api/config');
    expect(configuration.mode).toBe('fixture');
    await api.login();
    manifest = await loadFixtureManifest();
    connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
    temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
    await db.ping();
  }, 30_000);
  afterAll(async () => {
    // Tests leave readable audit records, while cancelling their remaining open cases.
    if (temporal) for (const id of created) {
      const app = await db.getApplication(id);
      if (app && !app.auditCommitted) {
        await temporal.workflow.getHandle(app.workflowId).cancel();
        await waitUntil(async () => Boolean((await db.getApplication(id))?.auditCommitted), 30_000);
      }
    }
    await db.close(); artifacts.close(); await connection?.close();
  }, 120_000);

  it('runs every scanned fixture and agrees across policy, artifact hashes, citations and audit export', async () => {
    expect(manifest.fixtures).toHaveLength(9);
    for (const fixture of manifest.fixtures) {
      const app = await upload(fixture.id);
      expect(app.status, fixture.id).toBe(fixture.expectedDecision);
      const audit = await api.audit(app.id);
      expect(audit.application.documentHash).toBe(fixture.sha256);
      expect(audit.application.policyHash).toBe(DEMO_POLICY.hash);
      expect(audit.application.policyVersion).toBe(DEMO_POLICY.version);
      const evidenceResponse = await api.request<{ ocr: unknown; extraction: unknown }>(`/api/applications/${app.id}/evidence`);
      const ocr = ocrManifestSchema.parse(evidenceResponse.ocr);
      const extraction = extractionArtifactSchema.parse(evidenceResponse.extraction);
      expect(ocr.documentHash).toBe(fixture.sha256);
      expect(extraction.documentHash).toBe(fixture.sha256);
      expect(extraction.mode).toBe('fixture');
      expect(ocr.engineVersion.toLowerCase()).toContain('tesseract');
      const ocrRef = artifactRefSchema.parse(app.data.ocrManifestRef);
      const extractionRef = artifactRefSchema.parse(app.data.extractionRef);
      expect(hashBytes(await artifacts.getBytes(ocrRef.key))).toBe(ocrRef.sha256);
      expect(extraction.ocrArtifactHash).toBe(ocrRef.sha256);
      expect(hashBytes(await artifacts.getBytes(extractionRef.key))).toBe(extractionRef.sha256);
      const evaluationEvent = audit.events.find((event) => event.type === 'POLICY_EVALUATED');
      const decision = policyDecisionSchema.parse(evaluationEvent?.payload.decision);
      expect(decision.outcome).toBe(fixture.expectedDecision);
      expect(decision.reasonCodes).toEqual(expect.arrayContaining(fixture.expectedReasonCodes));
      for (const field of fieldNames) for (const citation of extraction.result.fields[field].citations) {
        const page = ocr.pages.find((entry) => entry.pageNumber === citation.page);
        const block = page?.blocks.find((entry) => entry.id === citation.blockId);
        expect(block, `${fixture.id}:${field} citation exists`).toBeDefined();
        expect(block?.text).toContain(citation.quote);
        expect(citation.boundingBox).toEqual(block?.boundingBox);
      }
      const image = await api.response(`/api/applications/${app.id}/pages/1/image`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/png');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      const parent = await temporal.workflow.getHandle(app.workflowId).describe();
      const ocrChild = await temporal.workflow.getHandle(`${app.workflowId}-ocr`).describe();
      const extractionChild = await temporal.workflow.getHandle(`${app.workflowId}-extraction`).describe();
      expect(parent.type).toBe('loanApplicationWorkflow');
      expect(ocrChild.type).toBe('ocrDocumentWorkflow');
      expect(extractionChild.type).toBe(ANALYSIS_WORKFLOW_TYPE);
      expect(ocrChild.parentExecution?.workflowId).toBe(app.workflowId);
      expect(extractionChild.parentExecution?.workflowId).toBe(app.workflowId);
      const finals = audit.events.filter((event) => event.type === 'FINAL_COMMITTED');
      expect(finals).toHaveLength(fixture.expectedDecision === 'REVIEW' ? 0 : 1);
      if (finals[0]) {
        expect(finals[0].payload.originalRecommendation).toEqual(decision);
        expect(finals[0].payload.finalDecision).toEqual(decision);
        expect(audit.application.auditCommitted).toBe(true);
      }
    }
  }, 240_000);

  it('reserves one review revision, deduplicates the accepted Update and audits stale competitors', async () => {
    const app = await upload('borderline');
    const reviewCase = await db.getReviewCase(app.id);
    expect(reviewCase).not.toBeNull();
    const command = {
      commandId: randomUUID(), applicationId: app.id, workflowId: app.workflowId,
      workflowRunId: app.workflowRunId!, caseRevision: reviewCase!.caseRevision,
      evidenceRevision: reviewCase!.evidenceRevision, policyVersion: app.policyVersion,
      action: 'FINALIZE', decision: 'PASS', note: 'Fictional complete evidence reviewed; simulated borderline approval.',
    };
    const competing = { ...command, commandId: randomUUID(), note: 'A concurrent fictional review attempt.' };
    const post = (body: object) => api.response(`/api/reviews/${app.id}/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const results = await Promise.all([post(command), post(competing)]);
    expect(results.map((response) => response.status).sort()).toEqual([202, 409]);
    const accepted = results[0]!.status === 202 ? command : competing;
    await waitUntil(async () => (await db.getApplication(app.id))?.auditCommitted === true);
    const duplicate = await post(accepted);
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json() as { accepted: boolean }).accepted).toBe(true);
    const stale = await post({ ...accepted, commandId: randomUUID(), note: 'A stale fictional case revision.' });
    expect(stale.status).toBe(409);
    const changedDuplicate = await post({ ...accepted, note: 'Changed content with the accepted command ID.' });
    expect(changedDuplicate.status).toBe(409);
    const audit = await api.audit(app.id);
    expect(audit.application.status).toBe('PASS');
    expect(audit.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    expect(audit.events.filter((event) => event.type === 'REVIEW_COMMAND')).toHaveLength(1);
    expect(audit.commands.filter((entry) => entry.status === 'accepted')).toHaveLength(1);
    expect(audit.commands.filter((entry) => entry.status === 'rejected').length).toBeGreaterThanOrEqual(2);
    const reviewEvent = audit.events.find((event) => event.type === 'REVIEW_COMMAND')!;
    expect(reviewEvent.actorId).toBe('demo-reviewer');
    expect(reviewEvent.payload.note).toBe(accepted.note);
    const history = await temporal.workflow.getHandle(app.workflowId).fetchHistory();
    const update = (history.events ?? []).find((event) =>
      event.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.name === 'submitReview'
      && event.workflowExecutionUpdateAcceptedEventAttributes.acceptedRequest.meta?.updateId === accepted.commandId);
    const payload = update?.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.args?.payloads?.[0];
    expect(payload?.data).toBeDefined();
    const envelope: unknown = JSON.parse(Buffer.from(payload!.data!).toString('utf8'));
    const compact = reviewCommandSchema.parse(envelope);
    expect(envelope).not.toHaveProperty('note');
    expect(envelope).not.toHaveProperty('corrections');
    expect(JSON.stringify(envelope)).not.toContain(accepted.note);
    const content = await artifacts.getJson<{ note: string }>(compact.contentRef.key);
    expect(content.note).toBe(accepted.note);
    expect(hashBytes(await artifacts.getBytes(compact.contentRef.key))).toBe(compact.contentRef.sha256);
  }, 120_000);

  it('keeps human review open with no activity slots through API and parent-worker restarts', async () => {
    const app = await upload('borderline');
    const reviewBefore = await db.getReviewCase(app.id);
    await waitUntil(async () => ((await temporal.workflow.getHandle(app.workflowId).describe()).raw.pendingActivities?.length ?? 0) === 0);
    await execute('docker', ['compose', 'restart', 'api', 'application-worker'], { timeout: 120_000 });
    await waitUntil(async () => {
      try { return (await api.response('/api/health')).ok; } catch { return false; }
    });
    // The original opaque cookie must remain usable across stateless API replicas/restarts.
    const session = await api.request<{ identity: { id: string } }>('/api/session');
    expect(session.identity.id).toBe('demo-reviewer');
    const current = await api.application(app.id);
    expect(current.status).toBe('REVIEW');
    expect(current.workflowRunId).toBe(app.workflowRunId);
    expect(await db.getReviewCase(app.id)).toEqual(reviewBefore);
    const handle = temporal.workflow.getHandle(app.workflowId, app.workflowRunId!);
    const state = await handle.query<ApplicationState>('getApplicationState');
    expect(state.status).toBe('REVIEW');
    expect(state.caseRevision).toBe(reviewBefore!.caseRevision);
    const description = await handle.describe();
    expect(description.status.name).toBe('RUNNING');
    expect(description.raw.pendingActivities ?? []).toHaveLength(0);
    expect((await temporal.workflow.getHandle(`${app.workflowId}-ocr`).describe()).status.name).toBe('COMPLETED');
    expect((await temporal.workflow.getHandle(`${app.workflowId}-extraction`).describe()).status.name).toBe('COMPLETED');
  }, 180_000);

  it('preserves saving during a scoped review write fault and publishes each immutable correction revision', async () => {
    const app = await upload('borderline');
    const originalRef = artifactRefSchema.parse(app.data.extractionRef);
    const original = extractionArtifactSchema.parse(await artifacts.getJson(originalRef.key));
    const firstCase = (await db.getReviewCase(app.id))!;
    const command = {
      commandId: randomUUID(), applicationId: app.id, workflowId: app.workflowId,
      workflowRunId: app.workflowRunId!, caseRevision: firstCase.caseRevision,
      evidenceRevision: firstCase.evidenceRevision, policyVersion: app.policyVersion,
      action: 'CORRECT', note: 'Record income as unresolved rather than using an uncited replacement value.',
      corrections: { fields: { ...original.result.fields, grossMonthlyIncomeCents: {
        value: null, unit: null, period: null, citations: [], conflictingValues: [],
      } }, debtExcludesProposedLoan: original.result.facts.debtExcludesProposedLoan,
      cashPriceExcludesExtras: original.result.facts.cashPriceExcludesExtras,
      fixedApr: original.result.facts.fixedApr, notes: ['Income deliberately unresolved in this educational regression.'] },
    };
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) throw new Error('Database administrator connection required for scoped review persistence fault');
    const administrator = new pg.Pool({ connectionString: adminUrl });
    const faultName = `test_review_fault_${app.id.replaceAll('-', '')}`;
    await administrator.query(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.application_id = '${app.id}' AND NEW.event_type = 'EVIDENCE_CORRECTED' THEN
        RAISE EXCEPTION 'scoped integration review audit persistence fault';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${faultName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${faultName}()`);
    const handle = temporal.workflow.getHandle(app.workflowId, app.workflowRunId!);
    try {
      const accepted = await api.response(`/api/reviews/${app.id}/commands`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
      });
      expect(accepted.status).toBe(202);
      await waitUntil(async () => {
        const pending = (await handle.describe()).raw.pendingActivities ?? [];
        return pending.some((activity) => activity.activityType?.name === 'applyReview' && (activity.attempt ?? 0) >= 2);
      });
      expect((await handle.query<ApplicationState>('getApplicationState')).status).toBe('SAVING');
      expect((await api.audit(app.id)).events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(0);
      const history = await handle.fetchHistory();
      const reviewActivity = (history.events ?? []).find((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === 'applyReview')
        ?.activityTaskScheduledEventAttributes;
      expect(reviewActivity).toBeDefined();
      expect(reviewActivity?.retryPolicy?.maximumAttempts ?? 0).toBe(0);
      // Protobuf decoding may materialize an absent duration as an empty object.
      expect(Number(reviewActivity?.scheduleToCloseTimeout?.seconds ?? 0)).toBe(0);
      expect(reviewActivity?.scheduleToCloseTimeout?.nanos ?? 0).toBe(0);
    } finally {
      await administrator.query(`DROP TRIGGER IF EXISTS ${faultName} ON audit_events; DROP FUNCTION IF EXISTS ${faultName}()`);
      await administrator.end();
    }
    await waitUntil(async () => {
      const projection = await db.getApplication(app.id);
      const ref = artifactRefSchema.safeParse(projection?.data.extractionRef);
      return projection?.evidenceRevision === 2 && ref.success && ref.data.sha256 !== originalRef.sha256;
    });
    const missing = await api.request<{ extraction: unknown }>(`/api/applications/${app.id}/evidence`);
    const missingArtifact = extractionArtifactSchema.parse(missing.extraction);
    expect(missingArtifact.result.facts.grossMonthlyIncomeCents).toBeNull();
    expect(missingArtifact.result.issues.some((issue) => issue.code === 'EVIDENCE_MISSING')).toBe(true);
    const secondProjection = await api.application(app.id);
    const secondRef = artifactRefSchema.parse(secondProjection.data.extractionRef);
    expect(secondRef.key).not.toBe(originalRef.key);
    expect(hashBytes(await artifacts.getBytes(secondRef.key))).toBe(secondRef.sha256);
    expect(extractionArtifactSchema.parse(await artifacts.getJson(originalRef.key))).toEqual(original);

    const secondCase = (await db.getReviewCase(app.id))!;
    const restoredCommand = { ...command, commandId: randomUUID(), caseRevision: secondCase.caseRevision,
      evidenceRevision: secondCase.evidenceRevision, note: 'Restore the income using its original exact OCR quotations and source period.',
      corrections: { fields: original.result.fields, debtExcludesProposedLoan: original.result.facts.debtExcludesProposedLoan,
        cashPriceExcludesExtras: original.result.facts.cashPriceExcludesExtras,
        fixedApr: original.result.facts.fixedApr, notes: ['Original cited numeric evidence restored by the demo reviewer.'] },
    };
    expect((await api.response(`/api/reviews/${app.id}/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(restoredCommand),
    })).status).toBe(202);
    await waitUntil(async () => {
      const projection = await db.getApplication(app.id);
      const ref = artifactRefSchema.safeParse(projection?.data.extractionRef);
      return projection?.evidenceRevision === 3 && ref.success && ref.data.sha256 !== secondRef.sha256;
    });
    const restored = await api.request<{ extraction: unknown }>(`/api/applications/${app.id}/evidence`);
    expect(extractionArtifactSchema.parse(restored.extraction).result.facts).toEqual(original.result.facts);
    const thirdCase = (await db.getReviewCase(app.id))!;
    expect((await api.response(`/api/reviews/${app.id}/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), applicationId: app.id, workflowId: app.workflowId,
        workflowRunId: app.workflowRunId!, caseRevision: thirdCase.caseRevision,
        evidenceRevision: thirdCase.evidenceRevision, policyVersion: app.policyVersion,
        action: 'FINALIZE', decision: 'PASS', note: 'Complete restored fictional evidence reviewed; simulated borderline approval.' }),
    })).status).toBe(202);
    await waitUntil(async () => (await db.getApplication(app.id))?.auditCommitted === true);
    const audit = await api.audit(app.id);
    const finalRef = artifactRefSchema.parse(audit.application.data.extractionRef);
    const finalEvent = audit.events.find((event) => event.type === 'FINAL_COMMITTED')!;
    expect(audit.application.evidenceRevision).toBe(3);
    expect(finalEvent.evidenceRevision).toBe(3);
    expect(finalEvent.evidenceHash).toBe(finalRef.sha256);
    expect(hashBytes(await artifacts.getBytes(finalRef.key))).toBe(finalRef.sha256);
    expect(finalRef.key).not.toBe(secondRef.key);
    expect(extractionArtifactSchema.parse((await api.request<{ extraction: unknown }>(`/api/applications/${app.id}/evidence`)).extraction))
      .toEqual(await artifacts.getJson(finalRef.key));
    expect(audit.events.filter((event) => event.type === 'EVIDENCE_CORRECTED')).toHaveLength(2);
    expect(audit.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
  }, 180_000);

  it('keeps finalization pending during a scoped database write fault, then commits once after recovery', async () => {
    const id = randomUUID();
    const name = `test_final_fault_${id.replaceAll('-', '')}`;
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL or DATABASE_ADMIN_URL is required for the scoped finalization-fault test');
    const administrator = new pg.Pool({ connectionString: adminUrl });
    // The fault is a trigger on this UUID only, not a complete database outage.
    await administrator.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${id}' AND NEW.audit_committed THEN
        RAISE EXCEPTION 'scoped integration finalization persistence fault';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    let handle: Awaited<ReturnType<typeof directApplication>> | undefined;
    try {
      handle = await directApplication('pass', id);
      await waitUntil(async () => (await handle!.query<ApplicationState>('getApplicationState')).status === 'AUDIT_PENDING');
      const projection = await api.application(id);
      expect(projection.auditCommitted).toBe(false);
      expect(projection.status).not.toBe('PASS');
      const pendingAudit = await api.audit(id);
      expect(pendingAudit.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(0);
      expect((await handle.describe()).status.name).toBe('RUNNING');
    } finally {
      await administrator.query(`DROP TRIGGER IF EXISTS ${name} ON applications; DROP FUNCTION IF EXISTS ${name}()`);
      await administrator.end();
    }
    expect(handle).toBeDefined();
    await waitUntil(async () => (await db.getApplication(id))?.auditCommitted === true);
    const final = await api.audit(id);
    expect(final.application.status).toBe('PASS');
    expect(final.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    expect((await handle!.result() as ApplicationState).status).toBe('PASS');
  }, 180_000);

  it('retries an acknowledgement lost after the final database commit without creating another final decision', async () => {
    const id = randomUUID();
    const handle = await directApplication('pass', id, { simulateLostFinalAck: true });
    const result = await handle.result() as ApplicationState;
    expect(result.status).toBe('PASS');
    const audit = await api.audit(id);
    expect(audit.application.auditCommitted).toBe(true);
    expect(audit.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    const history = await handle.fetchHistory();
    const commit = (history.events ?? []).find((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === 'commitApplication');
    expect(commit).toBeDefined();
    const successfulAttempt = (history.events ?? []).find((event) =>
      event.activityTaskStartedEventAttributes
      && String(event.activityTaskStartedEventAttributes.scheduledEventId) === String(commit!.eventId));
    expect(successfulAttempt?.activityTaskStartedEventAttributes?.attempt).toBe(2);
  }, 120_000);

  it('closes with persisted PASS when cancellation arrives after commit but before acknowledgement', async () => {
    const id = randomUUID();
    const handle = await directApplication('pass', id, { simulateLostFinalAck: true, simulateFinalAckPauseMs: 5000 });
    await waitUntil(async () => (await db.getApplication(id))?.auditCommitted === true);
    expect((await handle.query<ApplicationState>('getApplicationState')).status).toBe('AUDIT_PENDING');
    await handle.cancel();
    const result = await handle.result() as ApplicationState;
    expect(result.status).toBe('PASS');
    const audit = await api.audit(id);
    expect(audit.application.status).toBe('PASS');
    expect(audit.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    expect(audit.events.filter((event) => event.type === 'LATE_CANCELLATION')).toHaveLength(1);
    expect((await handle.describe()).status.name).toBe('COMPLETED');
  }, 120_000);

  it('commits CANCELLED once when cancellation arrives before a blocked final write can commit', async () => {
    const id = randomUUID();
    const name = `test_cancel_pending_${id.replaceAll('-', '')}`;
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) throw new Error('Database administrator connection required for scoped pending cancellation test');
    const administrator = new pg.Pool({ connectionString: adminUrl });
    await administrator.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${id}' AND NEW.audit_committed AND NEW.status = 'PASS' THEN
        RAISE EXCEPTION 'scoped integration blocks uncommitted PASS';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      const handle = await directApplication('pass', id);
      await waitUntil(async () => (await handle.query<ApplicationState>('getApplicationState')).status === 'AUDIT_PENDING');
      expect((await db.getApplication(id))?.auditCommitted).toBe(false);
      await handle.cancel();
      const result = await handle.result() as ApplicationState;
      expect(result.status).toBe('CANCELLED');
      const audit = await api.audit(id);
      expect(audit.application.status).toBe('CANCELLED');
      expect(audit.application.auditCommitted).toBe(true);
      const finals = audit.events.filter((event) => event.type === 'FINAL_COMMITTED');
      expect(finals).toHaveLength(1);
      expect(finals[0]?.payload.status).toBe('CANCELLED');
    } finally {
      await administrator.query(`DROP TRIGGER IF EXISTS ${name} ON applications; DROP FUNCTION IF EXISTS ${name}()`);
      await administrator.end();
    }
  }, 120_000);
});
