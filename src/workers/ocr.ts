import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { ArtifactStore } from '../storage.js';
import { createOcrActivities } from '../activities/ocr.js';
const artifacts = new ArtifactStore();
const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
try {
  const worker = await Worker.create({
    connection, namespace: config.TEMPORAL_NAMESPACE, taskQueue: 'document-ocr',
    workflowsPath: fileURLToPath(new URL('../workflows/ocr.ts', import.meta.url)),
    activities: createOcrActivities(artifacts),
    maxConcurrentActivityTaskExecutions: config.OCR_ACTIVITY_SLOTS,
    maxConcurrentWorkflowTaskExecutions: 16,
    maxHeartbeatThrottleInterval: '5 seconds',
    enableSDKTracing: false,
  });
  await worker.run();
} finally { await connection.close(); artifacts.close(); }
