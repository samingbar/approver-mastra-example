import {
  ActivityCancellationType,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';

// Adapter 0.4.12 forwards only startToCloseTimeout. Native outbound interception
// configures the actual schedule command and retains generated execution.
export const interceptors: WorkflowInterceptorsFactory = () => {
  const extractionOptions: WorkflowOutboundCallsInterceptor = {
    scheduleActivity(input, next) {
      return next({
        ...input,
        options: {
          ...input.options,
          startToCloseTimeout: '90 seconds', scheduleToCloseTimeout: '5 minutes',
          heartbeatTimeout: '30 seconds',
          cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
          retry: {
            initialInterval: '1 second', maximumInterval: '30 seconds',
            backoffCoefficient: 2, maximumAttempts: 3,
            nonRetryableErrorTypes: ['AUTH_CONFIGURATION', 'ARTIFACT_INTEGRITY'],
          },
        },
      });
    },
  };
  return { outbound: [extractionOptions] };
};
