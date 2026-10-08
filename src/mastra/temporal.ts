import { Client, Connection } from '@temporalio/client';
import { init } from '@mastra/temporal';

// Node-only initialization. The compiler recognizes this literal init call.
const connection = Connection.lazy({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
export const temporalClient = new Client({
  connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
});
export const { createWorkflow, createStep } = init({
  client: temporalClient, taskQueue: 'loan-extraction', startToCloseTimeout: '90 seconds',
});
