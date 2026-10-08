import { Client, Connection, WorkflowUpdateFailedError, WorkflowNotFoundError, isGrpcServiceError } from '@temporalio/client';
import type { ApiWorkflowClient, ReviewCommand } from './app.js';
import { ReviewRejectedError, WorkflowStartRejectedError, WorkflowStartUnconfirmedError } from './app.js';
import { z } from 'zod';
import { applicationStatusSchema, policyDecisionSchema } from '../contracts.js';

const applicationStateSchema = z.object({
  applicationId: z.string(), workflowId: z.string(), workflowRunId: z.string(),
  status: applicationStatusSchema, stage: z.string(), caseRevision: z.number().int().nonnegative(),
  evidenceRevision: z.number().int().positive(), policyVersion: z.string(), overdue: z.boolean(),
  recommendation: policyDecisionSchema.optional(), savingCommandId: z.string().optional(),
}).strict();

export async function connectWorkflowClient(): Promise<{ workflows: ApiWorkflowClient; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default' });
  const workflows: ApiWorkflowClient = {
    async startApplication(input, workflowId) {
      try {
        const handle = await connection.withDeadline(Date.now() + 15_000, () => client.workflow.start('loanApplicationWorkflow', {
          args: [input], workflowId, taskQueue: 'loan-applications',
        }));
        return { runId: handle.firstExecutionRunId };
      } catch (startError) {
        // A lost start acknowledgement is not proof that the workflow did not start.
        try {
          const existing = await connection.withDeadline(Date.now() + 5_000, () => client.workflow.getHandle(workflowId).describe());
          return { runId: existing.runId };
        } catch {
          if (isGrpcServiceError(startError) && [3, 7, 16].includes(startError.code)) throw new WorkflowStartRejectedError('Temporal rejected the workflow start configuration or authorization.');
          throw new WorkflowStartUnconfirmedError('The workflow start acknowledgement could not be confirmed.');
        }
      }
    },
    async submitReview(command: ReviewCommand) {
      const handle = client.workflow.getHandle(command.workflowId, command.workflowRunId);
      try {
        return await connection.withDeadline(Date.now() + 15_000, () => handle.executeUpdate<Awaited<ReturnType<ApiWorkflowClient['submitReview']>>, [ReviewCommand]>('submitReview', {
          args: [command], updateId: command.commandId,
        }));
      } catch (error) {
        if (error instanceof WorkflowUpdateFailedError || error instanceof WorkflowNotFoundError) throw new ReviewRejectedError('The native workflow rejected this Update.');
        throw error;
      }
    },
    async queryApplicationState(workflowId, runId) {
      try {
        const handle = client.workflow.getHandle(workflowId, runId ?? undefined);
        const value = await connection.withDeadline(Date.now() + 3_000, () => handle.query<unknown>('getApplicationState'));
        const state = applicationStateSchema.parse(value);
        if (state.workflowId !== workflowId || (runId && state.workflowRunId !== runId)) return null;
        return state;
      } catch { return null; }
    },
  };
  return { workflows, close: () => connection.close() };
}
