import { z } from 'zod';
import { artifactRefSchema } from '../contracts.js';

// Verified against @mastra/temporal 0.4.12's toWorkflowType transformer.
// The registration ID is "extract-application"; it is not the Temporal type.
export const ANALYSIS_WORKFLOW_TYPE = 'extractApplicationWorkflow';
export const ANALYSIS_TASK_QUEUE = 'loan-extraction';
export const analysisInputSchema = z.object({
  applicationId: z.string().min(1),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  manifestRef: artifactRefSchema,
  mode: z.enum(['fixture', 'live']),
  analysisRevision: z.string().min(1),
}).strict();
export type AnalysisInput = z.infer<typeof analysisInputSchema>;

export const analysisOutputSchema = z.object({ extractionRef: artifactRefSchema }).strict();
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export const analysisStartEnvelopeSchema = z.object({
  inputData: analysisInputSchema,
  runId: z.string().optional(), resourceId: z.string().optional(),
  requestContext: z.record(z.string(), z.unknown()).optional(),
  initialState: z.unknown().optional(),
}).strict();

// This is the generated workflow result, before TemporalRun.start's wrapper.
export const generatedAnalysisResultSchema = z.object({
  status: z.literal('success'), input: analysisInputSchema,
  result: analysisOutputSchema, state: z.unknown().optional(),
  steps: z.object({
    extractRelevantFacts: z.object({ draftRef: artifactRefSchema }).strict(),
    validateAndSaveEvidence: analysisOutputSchema,
  }).strict(),
}).strict();

export function analysisChildArgs(input: AnalysisInput) {
  return [analysisStartEnvelopeSchema.parse({ inputData: input })] as const;
}

export function decodeAnalysisChildResult(value: unknown): AnalysisOutput {
  return generatedAnalysisResultSchema.parse(value).result;
}
