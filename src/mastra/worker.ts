import 'dotenv/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import { MastraPlugin } from '@mastra/temporal/worker';
import { fileURLToPath } from 'node:url';

export async function createExtractionWorker(taskQueue = process.env.EXTRACTION_TASK_QUEUE ?? 'loan-extraction'): Promise<Worker> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  });
  return Worker.create({
    connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default', taskQueue,
    plugins: [new MastraPlugin(fileURLToPath(new URL('./index.ts', import.meta.url)))],
    interceptors: {
      workflowModules: [fileURLToPath(new URL('../integration/extraction-options-interceptor.ts', import.meta.url))],
    },
    maxConcurrentActivityTaskExecutions: Number(process.env.EXTRACTION_ACTIVITY_SLOTS ?? process.env.EXTRACTION_WORKER_SLOTS ?? '4'),
    maxActivitiesPerSecond: Number(process.env.EXTRACTION_RATE_PER_SECOND ?? '4'),
    maxHeartbeatThrottleInterval: '5 seconds',
    shutdownGraceTime: '10 seconds',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = await createExtractionWorker();
  await worker.run();
}
