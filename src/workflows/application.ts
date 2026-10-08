import {
  ActivityFailure, ChildWorkflowFailure, ApplicationFailure, CancellationScope,
  ChildWorkflowCancellationType, ParentClosePolicy, allHandlersFinished,
  condition, defineQuery, defineUpdate, executeChild, isCancellation,
  proxyActivities, setHandler, sleep, workflowInfo,
  patched,
} from '@temporalio/workflow';
import { evaluatePolicy } from '../policy.js';
import { ANALYSIS_TASK_QUEUE, ANALYSIS_WORKFLOW_TYPE, analysisChildArgs, decodeAnalysisChildResult } from '../integration/analysis-child-contract.js';
import { ocrDocumentWorkflow } from './ocr.js';
import type { ApplicationActivities, CompactEvidence } from '../activities/application.js';
import type { ApplicationInput, ApplicationState, ReviewAcceptance, ReviewCommand } from './application-contract.js';
import { reviewCommandSchema } from './application-contract.js';
import type { ArtifactRef, ApplicationStatus, PolicyDecision } from '../contracts.js';

export const getApplicationState = defineQuery<ApplicationState>('getApplicationState');
export const submitReview = defineUpdate<ReviewAcceptance, [ReviewCommand]>('submitReview');
const persistence = proxyActivities<ApplicationActivities>({
  startToCloseTimeout: '30 seconds',
  // Omitting maximumAttempts means unlimited retries in this SDK; explicit 0 is rejected.
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});
const analysisIO = proxyActivities<Pick<ApplicationActivities, 'loadCompactEvidence'>>({
  startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '5 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds', maximumAttempts: 5 },
});

/** Native parent. No clients, SDK entry points, binaries, or database code are bundled here. */
export async function loanApplicationWorkflow(input: ApplicationInput): Promise<ApplicationState> {
  const info = workflowInfo();
  const state: ApplicationState = {
    applicationId: input.applicationId, workflowId: info.workflowId, workflowRunId: info.runId,
    status: 'UPLOADED', stage: 'upload', caseRevision: 0, evidenceRevision: 1,
    policyVersion: input.policy.version, overdue: false,
  };
  let pending: ReviewCommand | undefined;
  let finished = false;
  let overdueScope: CancellationScope | undefined;
  const commands = new Map<string, ReviewAcceptance>();
  setHandler(getApplicationState, () => ({ ...state }));
  // Validation and reservation are synchronous: two commands cannot own a revision.
  setHandler(submitReview, (command) => {
    const parsed = reviewCommandSchema.safeParse(command);
    if (!parsed.success) return { accepted: false, commandId: command?.commandId ?? 'invalid',
      caseRevision: state.caseRevision, evidenceRevision: state.evidenceRevision, status: state.status, message: 'Invalid review command schema.' };
    command = parsed.data;
    const prior = commands.get(command.commandId);
    if (prior) return prior;
    const invalid = !command.commandId || !command.actorId
      || command.applicationId !== input.applicationId || command.workflowId !== info.workflowId
      || command.workflowRunId !== info.runId || command.policyVersion !== input.policy.version
      || command.caseRevision !== state.caseRevision || command.evidenceRevision !== state.evidenceRevision
      || state.status !== 'REVIEW' || pending !== undefined || finished
      || (command.action === 'OVERRIDE' && command.actorRole !== 'override-reviewer')
      || (['FINALIZE', 'OVERRIDE'].includes(command.action) && !command.decision);
    const result: ReviewAcceptance = {
      accepted: !invalid, commandId: command.commandId,
      caseRevision: state.caseRevision + (invalid ? 0 : 1), evidenceRevision: state.evidenceRevision,
      status: invalid ? state.status : 'SAVING',
      ...(invalid ? { message: 'Closed, stale, unauthorized, incomplete, or already reserved review revision.' } : {}),
    };
    commands.set(command.commandId, result);
    if (!invalid) {
      pending = command;
      state.status = 'SAVING'; state.savingCommandId = command.commandId;
    }
    return result;
  });

  let extractionRef: ArtifactRef | undefined;
  let original: PolicyDecision | undefined;
  const progress = async (status: ApplicationStatus, stage: string, data: Record<string, unknown> = {}) => {
    state.status = status; state.stage = stage;
    await persistence.persistProgress({ applicationId: input.applicationId, workflowId: info.workflowId,
      workflowRunId: info.runId, status, stage, evidenceRevision: state.evidenceRevision, data });
  };
  const final = async (status: 'PASS' | 'FAIL' | 'NEEDS_DOCUMENTS' | 'INPUT_ERROR' | 'PROCESSING_ERROR' | 'CANCELLED',
    decision: PolicyDecision | undefined, authority: string, payload: Record<string, unknown> = {}, command?: ReviewCommand) => {
    finished = true;
    overdueScope?.cancel();
    state.status = 'AUDIT_PENDING'; state.stage = 'final audit';
    const persistedStatus = await persistence.commitApplication({ applicationId: input.applicationId, eventId: `${input.applicationId}:final`,
      status, originalRecommendation: original, finalDecision: decision, decisionAuthority: authority,
      reasonCodes: decision?.reasonCodes ?? [], evidenceRevision: state.evidenceRevision,
      ...(extractionRef ? { evidenceHash: extractionRef.sha256, artifactRefs: [extractionRef] } : {}),
      workflowId: info.workflowId, workflowRunId: info.runId,
      actorType: command ? 'reviewer' : 'system', ...(command ? { actorId: command.actorId } : {}),
      payload: { educationalSimulation: true, mode: input.mode, ...(extractionRef ? { extractionRef } : {}),
        ...(input.mode === 'fixture' && input.simulateFinalAckPauseMs && input.simulateFinalAckPauseMs <= 10_000 ? { simulateFinalAckPauseMs: input.simulateFinalAckPauseMs } : {}),
        ...(input.mode === 'fixture' && input.simulateLostFinalAck ? { simulateLostFinalAck: true } : {}), ...payload } });
    state.status = persistedStatus ?? status; state.stage = 'complete'; delete state.savingCommandId;
    await condition(allHandlersFinished);
    return { ...state };
  };

  try {
    await progress('OCR', 'render and OCR');
    const ocr = await executeChild(ocrDocumentWorkflow, {
      workflowId: `${info.workflowId}-ocr`, taskQueue: 'document-ocr', args: [{ document: input.document, documentHash: input.documentHash, ...(input.ocrVersion ? { ocrVersion: input.ocrVersion } : {}) }],
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED, parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    });
    await progress('EXTRACTING', 'bounded evidence extraction', { ocrManifestRef: ocr.manifest, qualityFlags: ocr.qualityFlags });
    await persistence.applicationEvent({ applicationId: input.applicationId, eventId: `${input.applicationId}:ocr`,
      type: 'OCR_COMPLETED', artifactRefs: [ocr.manifest], payload: { qualityFlags: ocr.qualityFlags, childWorkflowId: `${info.workflowId}-ocr` } });
    const generated = await executeChild(ANALYSIS_WORKFLOW_TYPE, {
      workflowId: `${info.workflowId}-extraction`, taskQueue: ANALYSIS_TASK_QUEUE,
      args: [...analysisChildArgs({ applicationId: input.applicationId, documentHash: input.documentHash,
        manifestRef: ocr.manifest, mode: input.mode, analysisRevision: input.analysisRevision ?? `loan-evidence-v1:${input.mode}` })],
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED, parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    });
    extractionRef = decodeAnalysisChildResult(generated).extractionRef;
    if (patched('extraction-audit-v1')) {
      await persistence.applicationEvent({ applicationId: input.applicationId, eventId: `${input.applicationId}:extraction`,
        type: 'EXTRACTION_COMPLETED', artifactRefs: [extractionRef], evidenceHash: extractionRef.sha256,
        payload: { childWorkflowId: `${info.workflowId}-extraction`, mode: input.mode } });
    }
    await progress('EVALUATING', 'demo policy', { extractionRef });
    let compact: CompactEvidence = await analysisIO.loadCompactEvidence(extractionRef);
    let decision = evaluatePolicy(compact.facts, compact.issues, input.policy);
    original = decision; state.recommendation = decision;
    await persistence.applicationEvent({ applicationId: input.applicationId, eventId: `${input.applicationId}:evaluation`,
      type: 'POLICY_EVALUATED', reasonCodes: decision.reasonCodes, evidenceHash: extractionRef.sha256,
      payload: { decision, mode: input.mode } });
    if (decision.outcome !== 'REVIEW') return await final(decision.outcome, decision, 'demo-policy');
    state.caseRevision = 1;
    const openCase = async () => {
      await persistence.openApplicationReview({ applicationId: input.applicationId, caseRevision: state.caseRevision,
        evidenceRevision: state.evidenceRevision, policyVersion: input.policy.version, workflowId: info.workflowId,
        workflowRunId: info.runId, payload: { decision, extractionRef, originalRecommendation: original, issues: compact.issues } });
      await progress('REVIEW', 'awaiting human review', { recommendation: decision, caseRevision: state.caseRevision, extractionRef });
    };
    await openCase();
    // The durable timer marks overdue, never decides the application.
    overdueScope = new CancellationScope({ cancellable: true });
    const overdueTimer = overdueScope.run(async () => {
      await sleep('24 hours');
      if (!finished) {
        state.overdue = true;
        await persistence.markApplicationOverdue(input.applicationId);
      }
    }).catch(error => { if (!isCancellation(error)) throw error; });
    void overdueTimer;
    while (!finished) {
      await condition(() => pending !== undefined);
      const command = pending!;
      pending = undefined;
      state.caseRevision++;
      const reviewed: Awaited<ReturnType<ApplicationActivities['applyReview']>> = await persistence.applyReview({ applicationId: input.applicationId, command,
        extractionRef: extractionRef!, manifestRef: ocr.manifest, evidenceRevision: state.evidenceRevision, policy: input.policy });
      if (reviewed.extractionRef) {
        extractionRef = reviewed.extractionRef; compact = reviewed.compact;
        state.evidenceRevision++; decision = evaluatePolicy(compact.facts, compact.issues, input.policy);
        state.recommendation = decision;
      }
      if (command.action === 'REQUEST_DOCUMENTS') return await final('NEEDS_DOCUMENTS', decision, 'reviewer', { commandId: command.commandId, contentRef: command.contentRef }, command);
      if (command.action === 'OVERRIDE') {
        const overrideDecision = { ...decision, outcome: command.decision! };
        return await final(command.decision!, overrideDecision, 'educational-reviewer-override', {
          override: true, label: 'OVERRIDE', commandId: command.commandId, contentRef: command.contentRef,
          originalRecommendation: original, policyRecommendation: decision,
        }, command);
      }
      if (command.action === 'FINALIZE' && reviewed.canFinalize && command.decision
          && (decision.outcome === 'REVIEW' || decision.outcome === command.decision)) {
        return await final(command.decision, { ...decision, outcome: command.decision }, 'reviewer', { commandId: command.commandId, contentRef: command.contentRef }, command);
      }
      if (command.action === 'CORRECT' && decision.outcome !== 'REVIEW') return await final(decision.outcome, decision, 'reviewer-correction', { commandId: command.commandId, contentRef: command.contentRef }, command);
      delete state.savingCommandId;
      await openCase();
    }
    throw new Error('Unreachable finalization state');
  } catch (error) {
    if (isCancellation(error)) {
      return await CancellationScope.nonCancellable(() => final('CANCELLED', undefined, 'operator', { code: 'CANCELLED' }));
    }
    // Runtime defects must remain Workflow Task failures, not become decisions.
    if (!(error instanceof ActivityFailure) && !(error instanceof ChildWorkflowFailure)) throw error;
    let cause: unknown = error;
    while ((cause instanceof ActivityFailure || cause instanceof ChildWorkflowFailure || cause instanceof ApplicationFailure) && cause.cause) cause = cause.cause;
    const code = cause instanceof ApplicationFailure ? cause.type : 'PROCESSING_RETRIES_EXHAUSTED';
    return await final(code === 'INPUT_ERROR' ? 'INPUT_ERROR' : 'PROCESSING_ERROR', undefined, 'technical-error', { code, failedStage: state.stage, recoverable: true });
  }
}
