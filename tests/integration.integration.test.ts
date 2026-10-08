import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Connection, Client } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/storage.js';
import { loadFixtureManifest } from '../src/fixtures/index.js';
import { extractionArtifactSchema, ocrManifestSchema, type OcrBlock } from '../src/contracts.js';
import { generatedAnalysisResultSchema, type AnalysisInput } from '../src/integration/analysis-child-contract.js';

function startExtractionWorker(taskQueue: string, validationDelayMs: string, failAttempts = '0'): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/mastra/worker.ts'], {
    cwd: process.cwd(), env: { ...process.env, EXTRACTION_TASK_QUEUE: taskQueue,
      EXTRACTION_VALIDATE_DELAY_MS: validationDelayMs, EXTRACTION_FAIL_ATTEMPTS: failAttempts,
      EXTRACTION_FAILURE_CODE: 'PROVIDER_429' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let recentOutput = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (data: Buffer) => {
    recentOutput = `${recentOutput}${data.toString()}`.slice(-4000);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGKILL' && signal !== 'SIGTERM') console.error(recentOutput);
  });
  return child;
}

async function startNativeProbe() {
  const id = randomUUID();
  const taskQueue = `integration-extraction-${id}`;
  const nativeQueue = `integration-parent-${id}`;
  const childId = `integration-child-${id}`;
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const client = new Client({ connection });
  const nativeConnection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const worker = await Worker.create({ connection: nativeConnection, taskQueue: nativeQueue,
    workflowsPath: fileURLToPath(new URL('./fixtures/integration-parent.ts', import.meta.url)) });
  const running = worker.run();
  const store = new ArtifactStore();
  await store.ensureBucket();
  const fixture = (await loadFixtureManifest()).fixtures[0];
  const manifest = ocrManifestSchema.parse({
    documentHash: fixture.sha256, ocrVersion: 'contract-error-probe-v1', engineVersion: 'test-input',
    pages: [{ pageNumber: 1, width: 100, height: 100,
      imageRef: { key: `integration/${id}/image.png`, sha256: fixture.sha256, size: 0, contentType: 'image/png' },
      pageHash: fixture.sha256, engineVersion: 'test-input', blocks: [] }], qualityFlags: [],
  });
  const manifestRef = await store.putJsonImmutable(`integration/${id}/ocr.json`, manifest);
  const input: AnalysisInput = { applicationId: id, documentHash: fixture.sha256,
    manifestRef, mode: 'fixture', analysisRevision: `integration-${id}` };
  return {
    client, childId, taskQueue,
    async start() {
      return client.workflow.start('integrationParent', { workflowId: `integration-parent-${id}`,
        taskQueue: nativeQueue, args: [input, taskQueue, childId] });
    },
    async close() { worker.shutdown(); await running; store.close(); await nativeConnection.close(); await connection.close(); },
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error('Timed out waiting for Temporal history checkpoint');
}

describe('real MastraPlugin generation and native Temporal child contract', () => {
  it('recovers the generated child after SIGKILL and keeps its completed first step', async () => {
    const id = randomUUID();
    const taskQueue = `integration-extraction-${id}`;
    const nativeQueue = `integration-parent-${id}`;
    const childId = `integration-child-${id}`;
    const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
    const client = new Client({ connection });
    const nativeConnection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
    const parentWorker = await Worker.create({
      connection: nativeConnection, taskQueue: nativeQueue,
      workflowsPath: fileURLToPath(new URL('./fixtures/integration-parent.ts', import.meta.url)),
    });
    const parentRunning = parentWorker.run();
    const store = new ArtifactStore();
    let extractionWorker: ChildProcess | undefined;
    try {
      await store.ensureBucket();
      const fixture = (await loadFixtureManifest()).fixtures.find((entry) => entry.id === 'pass')!;
      const imageRef = await store.putImmutable(`integration/${id}/page.png`, Buffer.from('contract test image reference'), 'image/png');
      const sectionByField: Record<string, OcrBlock['section']> = {
        grossMonthlyIncomeCents: 'income', existingMonthlyDebtCents: 'debts', creditScore: 'bureau',
      };
      const blocks = Object.entries(fixture.sourceCoordinates).flatMap(([field, citations]) => citations.map((citation, index) => ({
        id: `${field}-${index}`, text: citation.quotation,
        boundingBox: { x: citation.bbox[0], y: citation.bbox[1], width: citation.bbox[2], height: citation.bbox[3] },
        confidence: 99, tokens: citation.quotation.split(/\s+/).map((text) => ({ text, confidence: 99 })),
        section: sectionByField[field] ?? 'terms' as OcrBlock['section'],
      })));
      blocks.push({ id: 'semantic-clauses', text: 'Existing debt excludes proposed loan. Cash price excludes taxes and fees.',
        boundingBox: { x: 100, y: 100, width: 500, height: 30 }, confidence: 99,
        tokens: [{ text: 'excludes', confidence: 99 }], section: 'terms' });
      const manifest = ocrManifestSchema.parse({
        documentHash: fixture.sha256, ocrVersion: 'integration-contract-v1', engineVersion: 'test-input',
        pages: [{ pageNumber: 1, width: 1275, height: 1650, imageRef, pageHash: imageRef.sha256,
          engineVersion: 'test-input', blocks }], qualityFlags: [],
      });
      const manifestRef = await store.putJsonImmutable(`integration/${id}/ocr.json`, manifest);
      const input: AnalysisInput = { applicationId: id, documentHash: fixture.sha256, manifestRef,
        mode: 'fixture', analysisRevision: `integration-${id}` };
      extractionWorker = startExtractionWorker(taskQueue, '60000');
      const parent = await client.workflow.start('integrationParent', {
        workflowId: `integration-parent-${id}`, taskQueue: nativeQueue, args: [input, taskQueue, childId],
      });
      const child = client.workflow.getHandle(childId);
      await waitUntil(async () => {
        if (extractionWorker?.exitCode !== null) throw new Error('Generated extraction worker exited before checkpoint');
        try {
          const history = await child.fetchHistory();
          const completed = history.events?.some((event) => !!event.activityTaskCompletedEventAttributes);
          const scheduled = history.events?.filter((event) => !!event.activityTaskScheduledEventAttributes).length ?? 0;
          return !!completed && scheduled === 2;
        } catch { return false; }
      });
      extractionWorker.kill('SIGKILL');
      await new Promise<void>((resolve) => extractionWorker!.once('exit', () => resolve()));
      extractionWorker = startExtractionWorker(taskQueue, '0');
      const output = await parent.result() as { extractionRef: { key: string } };
      const generated = generatedAnalysisResultSchema.parse(await child.result());
      expect(output).toEqual(generated.result);
      const artifact = extractionArtifactSchema.parse(await store.getJson(output.extractionRef.key));
      expect(artifact.result.facts.creditScore).toBe(740);
      const history = await child.fetchHistory();
      const scheduled = history.events!.filter((event) => event.activityTaskScheduledEventAttributes)
        .map((event) => event.activityTaskScheduledEventAttributes!);
      expect(scheduled.map((event) => event.activityType?.name)).toEqual(['extractRelevantFacts', 'validateAndSaveEvidence']);
      for (const event of scheduled) {
        expect(Number(event.startToCloseTimeout?.seconds)).toBe(90);
        expect(Number(event.scheduleToCloseTimeout?.seconds)).toBe(300);
        expect(event.retryPolicy?.maximumAttempts).toBe(3);
      }
      const firstScheduleEventId = history.events!.find((event) => event.activityTaskScheduledEventAttributes)?.eventId;
      const firstCompletions = history.events!.filter((event) =>
        String(event.activityTaskCompletedEventAttributes?.scheduledEventId) === String(firstScheduleEventId));
      expect(firstCompletions).toHaveLength(1);
      expect(history.events!.some((event) => event.workflowExecutionCompletedEventAttributes)).toBe(true);
    } finally {
      extractionWorker?.kill('SIGTERM');
      parentWorker.shutdown();
      await parentRunning;
      await nativeConnection.close(); await connection.close(); store.close();
    }
  }, 150_000);

  it('exhausts exactly three generated activity attempts and fails the native child', async () => {
    const probe = await startNativeProbe();
    const extractionWorker = startExtractionWorker(probe.taskQueue, '0', '3');
    try {
      const parent = await probe.start();
      await expect(parent.result()).rejects.toThrow('Workflow execution failed');
      const child = probe.client.workflow.getHandle(probe.childId);
      expect((await child.describe()).status.name).toBe('FAILED');
      const history = await child.fetchHistory();
      const started = history.events!.filter((event) => event.activityTaskStartedEventAttributes)
        .map((event) => event.activityTaskStartedEventAttributes!.attempt);
      expect(started).toEqual([3]);
      const failed = history.events!.find((event) => event.activityTaskFailedEventAttributes)!.activityTaskFailedEventAttributes!;
      expect(failed.failure?.applicationFailureInfo?.type).toBe('PROVIDER_429');
      const scheduled = history.events!.find((event) => event.activityTaskScheduledEventAttributes)!.activityTaskScheduledEventAttributes!;
      expect(Number(scheduled.retryPolicy?.initialInterval?.seconds)).toBe(1);
      expect(Number(scheduled.retryPolicy?.maximumInterval?.seconds)).toBe(30);
      expect(scheduled.retryPolicy?.backoffCoefficient).toBe(2);
      expect(history.events!.some((event) => event.workflowExecutionFailedEventAttributes)).toBe(true);
      expect(history.events!.some((event) => event.activityTaskCompletedEventAttributes)).toBe(false);
    } finally { extractionWorker.kill('SIGTERM'); await probe.close(); }
  }, 90_000);

  it('propagates parent cancellation into the generated child and cooperative activity', async () => {
    const probe = await startNativeProbe();
    const extractionWorker = startExtractionWorker(probe.taskQueue, '60000');
    try {
      const parent = await probe.start();
      const child = probe.client.workflow.getHandle(probe.childId);
      await waitUntil(async () => {
        try {
          const description = await child.describe();
          return description.raw.pendingActivities?.some((activity) =>
            activity.activityType?.name === 'validateAndSaveEvidence' && activity.state === 2
            && !!activity.lastHeartbeatTime) ?? false;
        } catch { return false; }
      });
      await parent.cancel();
      await expect(parent.result()).rejects.toThrow('Workflow execution cancelled');
      expect((await child.describe()).status.name).toBe('CANCELLED');
      const history = await child.fetchHistory();
      expect(history.events!.some((event) => event.workflowExecutionCancelRequestedEventAttributes)).toBe(true);
      expect(history.events!.some((event) => event.activityTaskCancelRequestedEventAttributes)).toBe(true);
      expect(history.events!.some((event) => event.activityTaskCanceledEventAttributes)).toBe(true);
      const canceled = history.events!.find((event) => event.activityTaskCanceledEventAttributes)!.activityTaskCanceledEventAttributes!;
      expect(Number(canceled.startedEventId)).toBeGreaterThan(0);
      expect(history.events!.some((event) => event.workflowExecutionCanceledEventAttributes)).toBe(true);
    } finally { extractionWorker.kill('SIGTERM'); await probe.close(); }
  }, 90_000);
});
