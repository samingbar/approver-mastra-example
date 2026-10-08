import type { ArtifactRef, ApplicationStatus, PolicySnapshot, PolicyDecision } from '../contracts.js';
import { artifactRefSchema, rawExtractionSchema } from '../contracts.js';
import { z } from 'zod';

export interface ApplicationInput {
  applicationId: string;
  document: ArtifactRef;
  documentHash: string;
  mode: 'fixture' | 'live';
  policy: PolicySnapshot;
  revision: number;
  parentApplicationId?: string;
  /** Internal demo replay/failure/load revisions; never accepted from an upload form. */
  ocrVersion?: string;
  analysisRevision?: string;
  /** Internal fixture test: simulate a committed final write whose acknowledgement was lost. */
  simulateLostFinalAck?: boolean;
  /** Internal fixture test: cancellation after commit but before its acknowledgement. */
  simulateFinalAckPauseMs?: number;
}

export interface ApplicationState {
  applicationId: string;
  workflowId: string;
  workflowRunId: string;
  status: ApplicationStatus;
  stage: string;
  caseRevision: number;
  evidenceRevision: number;
  policyVersion: string;
  recommendation?: PolicyDecision;
  overdue: boolean;
  savingCommandId?: string;
}

export interface ReviewCommand {
  commandId: string;
  applicationId: string;
  workflowId: string;
  workflowRunId: string;
  caseRevision: number;
  evidenceRevision: number;
  policyVersion: string;
  action: 'CORRECT' | 'VERIFY' | 'FINALIZE' | 'OVERRIDE' | 'REQUEST_DOCUMENTS';
  contentRef: ArtifactRef;
  actorId: string;
  actorRole: 'reviewer' | 'override-reviewer';
  decision?: 'PASS' | 'FAIL';
}

export interface ReviewAcceptance {
  accepted: boolean;
  commandId: string;
  caseRevision: number;
  evidenceRevision: number;
  status: ApplicationStatus;
  message?: string;
}

export const reviewCommandSchema = z.object({
  commandId: z.string().min(1).max(128), applicationId: z.string().min(1),
  workflowId: z.string().min(1), workflowRunId: z.string().min(1),
  caseRevision: z.number().int().positive(), evidenceRevision: z.number().int().positive(),
  policyVersion: z.string().min(1), action: z.enum(['CORRECT', 'VERIFY', 'FINALIZE', 'OVERRIDE', 'REQUEST_DOCUMENTS']),
  contentRef: artifactRefSchema.refine(ref => ref.contentType === 'application/json' && ref.size > 0 && ref.size <= 512 * 1024, 'A bounded immutable review-content artifact is required.'),
  actorId: z.string().min(1), actorRole: z.enum(['reviewer', 'override-reviewer']),
  decision: z.enum(['PASS', 'FAIL']).optional(),
}).strict().refine(command => command.contentRef.key.startsWith(`reviews/${command.applicationId}/${command.commandId}/`) && command.contentRef.key.endsWith('.json'), 'Review content must be bound to the application and command.');

/** Read only by Node activities. Notes and quoted corrections never enter workflow history. */
export const reviewContentSchema = z.object({
  applicationId: z.string().min(1), commandId: z.string().min(1),
  action: z.enum(['CORRECT', 'VERIFY', 'FINALIZE', 'OVERRIDE', 'REQUEST_DOCUMENTS']),
  note: z.string().trim().min(1).max(4000), corrections: rawExtractionSchema.optional(),
}).strict().superRefine((content, context) => {
  if (content.action === 'CORRECT' && !content.corrections) context.addIssue({ code: 'custom', message: 'Cited corrections are required.' });
  if (content.action !== 'CORRECT' && content.corrections) context.addIssue({ code: 'custom', message: 'Corrections require CORRECT.' });
});
