import {
  ChildWorkflowCancellationType, executeChild, ParentClosePolicy,
} from '@temporalio/workflow';
import {
  ANALYSIS_WORKFLOW_TYPE, analysisChildArgs, decodeAnalysisChildResult,
  type AnalysisInput,
} from '../../src/integration/analysis-child-contract.js';

export async function integrationParent(input: AnalysisInput, taskQueue: string, childId: string) {
  const result: unknown = await executeChild(ANALYSIS_WORKFLOW_TYPE, {
    workflowId: childId, taskQueue, args: analysisChildArgs(input),
    cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    parentClosePolicy: ParentClosePolicy.TERMINATE,
  });
  return decodeAnalysisChildResult(result);
}
