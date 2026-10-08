import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { ArtifactStore, PgStore } from '../storage.js';
import { createApplicationActivities } from '../activities/application.js';
const db = new PgStore();
const artifacts = new ArtifactStore();
const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
try {
  const worker = await Worker.create({
    connection, namespace: config.TEMPORAL_NAMESPACE, taskQueue: 'loan-applications',
    workflowsPath: fileURLToPath(new URL('../workflows/application.ts', import.meta.url)),
    activities: createApplicationActivities(db, artifacts),
    maxConcurrentActivityTaskExecutions: config.APPLICATION_ACTIVITY_SLOTS,
    maxConcurrentWorkflowTaskExecutions: 16,
    enableSDKTracing: false,
  });
  await worker.run();
} finally { await connection.close(); await db.close(); artifacts.close(); }
