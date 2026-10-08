import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { loadFixtureManifest, readFixtureBytes } from '../src/fixtures/index.js';
import { DemoClient } from './demo-client.js';
import { ArtifactStore, PgStore, type ApplicationProjection } from '../src/storage.js';
import { DEMO_POLICY } from '../src/policy.js';
import type { ApplicationInput } from '../src/workflows/application-contract.js';

const run = promisify(execFile);
const args = process.argv.slice(2);
function argument(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}
const count = Number(argument('--count', '100'));
assert(Number.isInteger(count) && count >= 1 && count <= 100, '--count must be an integer from 1 to 100');
const waitingReviews = args.includes('--reviews');
const compare = args.includes('--compare');
const cold = args.includes('--cold');
assert(!(waitingReviews && compare), 'Run --reviews separately from --compare so open cases do not affect comparison admission');
const timeoutMs = Number(argument('--timeout-minutes', '20')) * 60_000;
assert(Number.isFinite(timeoutMs) && timeoutMs > 0, '--timeout-minutes must be positive');
const client = new DemoClient();
const manifest = await loadFixtureManifest();
const fixture = manifest.fixtures.find((entry) => entry.id === (waitingReviews ? 'borderline' : 'pass'));
if (!fixture) throw new Error('Required synthetic benchmark fixture missing');
await client.login();
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
const temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
const database = cold ? new PgStore() : undefined;
const objects = cold ? new ArtifactStore() : undefined;

interface ResourceSample {
  timestamp: string;
  containers: object[];
  processRssKiB?: Record<string, { pid: number; rssKiB: number; commandName: string }[]>;
  unavailable?: string;
}
interface BatchReport {
  workerReplicas: number | 'existing'; count: number; kind: 'open-human-reviews' | 'audited-pass';
  durationSeconds: number; throughputApplicationsPerSecond: number; latencySeconds: { p50: number; p95: number; max: number };
  applicationIds: string[]; activeActivitiesAtReview?: number; duplicateFinalDecisions: number;
  activityScheduleToStartSeconds: { count: number; p50: number; p95: number; max: number };
  activityExecutionSeconds: { count: number; p50: number; p95: number; max: number };
  resources: ResourceSample[]; limits: Record<string, string | number>; notes: string[];
}

async function sampleResources(): Promise<ResourceSample> {
  const timestamp = new Date().toISOString();
  try {
    const listed = await run('docker', ['compose', 'ps', '-q', 'application-worker', 'ocr-worker', 'extraction-worker'], { timeout: 10_000 });
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return { timestamp, containers: [], unavailable: 'No Compose worker containers; process memory is not measured for host workers' };
    const sampled = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], { timeout: 10_000 });
    const containers = sampled.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as object);
    const processes = await Promise.all(ids.map(async (id) => {
      const output = await run('docker', ['top', id, '-eo', 'pid,rss,comm'], { timeout: 10_000 });
      const rows = output.stdout.trim().split('\n').slice(1).map((line) => {
        const [pid, rss, ...name] = line.trim().split(/\s+/);
        return { pid: Number(pid), rssKiB: Number(rss), commandName: name.join(' ') };
      });
      return [id, rows] as const;
    }));
    return { timestamp, containers, processRssKiB: Object.fromEntries(processes) };
  } catch {
    return { timestamp, containers: [], unavailable: 'Docker process metrics unavailable; local workflow metrics remain valid' };
  }
}

async function scale(replicas: number): Promise<void> {
  console.log(`Starting ${replicas} worker replicas per shared task queue with unchanged Compose CPU/memory limits.`);
  await run('docker', ['compose', 'up', '-d', '--no-build', '--no-deps',
    '--scale', `application-worker=${replicas}`, '--scale', `ocr-worker=${replicas}`,
    '--scale', `extraction-worker=${replicas}`, 'application-worker', 'ocr-worker', 'extraction-worker'],
  { timeout: 180_000, maxBuffer: 5 * 1024 * 1024 });
}

async function submit(revision: string): Promise<{ applicationId: string; workflowId: string }> {
  if (!cold) return await client.upload(fixture!);
  const applicationId = randomUUID();
  const workflowId = `loan-${applicationId}`;
  const bytes = await readFixtureBytes(fixture!.id);
  const document = await objects!.putImmutable(`documents/${fixture!.sha256}.pdf`, bytes, 'application/pdf');
  await database!.createApplication({ id: applicationId, documentKey: document.key, documentHash: document.sha256,
    mode: 'fixture', workflowId, policyVersion: DEMO_POLICY.version, policyHash: DEMO_POLICY.hash,
    admissionLimit: Number(process.env.MAX_ACTIVE_APPLICATIONS ?? 200),
    data: { educationalSimulation: true, sourceVerifiedFixture: true, uploadedBy: 'demo-load', coldBenchmark: true },
  });
  const input: ApplicationInput = { applicationId, document, documentHash: document.sha256, mode: 'fixture',
    policy: DEMO_POLICY, revision: 1, ocrVersion: revision, analysisRevision: revision };
  const handle = await temporal.workflow.start('loanApplicationWorkflow', {
    workflowId, taskQueue: 'loan-applications', args: [input],
  });
  await database!.updateApplication(applicationId, { workflowRunId: handle.firstExecutionRunId });
  return { applicationId, workflowId };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0,
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 };
}

function timestamp(value: { seconds?: unknown; nanos?: number | null } | null | undefined): number {
  return value ? Number(value.seconds ?? 0) * 1000 + (value.nanos ?? 0) / 1_000_000 : 0;
}

async function measureActivities(workflowId: string): Promise<{ queue: number[]; execution: number[] }> {
  const history = await temporal.workflow.getHandle(workflowId).fetchHistory();
  const scheduled = new Map<string, number>();
  const started = new Map<string, number>();
  const queue: number[] = [];
  const execution: number[] = [];
  for (const event of history.events ?? []) {
    if (event.activityTaskScheduledEventAttributes) scheduled.set(String(event.eventId), timestamp(event.eventTime));
    const start = event.activityTaskStartedEventAttributes;
    if (start) {
      const id = String(start.scheduledEventId);
      const startTime = timestamp(event.eventTime);
      started.set(id, startTime);
      if (scheduled.has(id)) queue.push((startTime - scheduled.get(id)!) / 1000);
    }
    const finish = event.activityTaskCompletedEventAttributes
      ?? event.activityTaskFailedEventAttributes ?? event.activityTaskCanceledEventAttributes;
    if (finish) {
      const startTime = started.get(String(finish.scheduledEventId));
      if (startTime !== undefined) execution.push((timestamp(event.eventTime) - startTime) / 1000);
    }
  }
  return { queue, execution };
}

async function batch(replicas: number | 'existing'): Promise<BatchReport> {
  const started = Date.now();
  const submitted: { id: string; submittedAt: number }[] = [];
  const resources: ResourceSample[] = [await sampleResources()];
  // Uploads are bounded; API admission is still enforced transactionally across replicas.
  for (let offset = 0; offset < count; offset += 10) {
    const uploaded = await Promise.all(Array.from({ length: Math.min(10, count - offset) }, async () => {
      const submittedAt = Date.now();
      const result = await submit(`load-${started}-${offset}-${randomUUID()}`);
      return { id: result.applicationId, submittedAt };
    }));
    submitted.push(...uploaded);
  }
  const ready = new Map<string, { app: ApplicationProjection; observedAt: number }>();
  const deadline = started + timeoutMs;
  let lastResourceSample = Date.now();
  let lastProgress = 0;
  while (ready.size < count && Date.now() < deadline) {
    const remaining = submitted.filter((entry) => !ready.has(entry.id));
    for (let offset = 0; offset < remaining.length; offset += 20) {
      await Promise.all(remaining.slice(offset, offset + 20).map(async (entry) => {
        const app = await client.application(entry.id);
        if (['INPUT_ERROR', 'PROCESSING_ERROR', 'CANCELLED', 'FAIL'].includes(app.status)) {
          throw new Error(`Benchmark application ${entry.id} reached unexpected ${app.status}; inspect its audit and Temporal history`);
        }
        if ((waitingReviews && app.status === 'REVIEW') || (!waitingReviews && app.status === 'PASS' && app.auditCommitted)) {
          ready.set(entry.id, { app, observedAt: Date.now() });
        }
      }));
    }
    if (Date.now() - lastProgress >= 5_000) {
      console.log(`${ready.size}/${count} applications ${waitingReviews ? 'waiting for review' : 'committed'}; ${Math.round((Date.now() - started) / 1000)}s elapsed`);
      lastProgress = Date.now();
    }
    if (Date.now() - lastResourceSample >= 15_000) {
      resources.push(await sampleResources()); lastResourceSample = Date.now();
    }
    if (ready.size < count) await delay(750);
  }
  assert.equal(ready.size, count, 'Every admitted application must reach its expected durable state');
  const durationSeconds = (Date.now() - started) / 1000;
  const latencies = submitted.map((entry) => (ready.get(entry.id)!.observedAt - entry.submittedAt) / 1000).sort((a, b) => a - b);
  let activeActivitiesAtReview = 0;
  let duplicateFinalDecisions = 0;
  const queueDurations: number[] = [];
  const executionDurations: number[] = [];
  for (const entry of submitted) {
    const { app } = ready.get(entry.id)!;
    const audit = await client.audit(entry.id);
    const finalCount = audit.events.filter((event) => event.type === 'FINAL_COMMITTED').length;
    duplicateFinalDecisions += Math.max(0, finalCount - 1);
    assert.equal(finalCount, waitingReviews ? 0 : 1, 'Final audit decisions must commit exactly once');
    for (const workflowId of [app.workflowId, `${app.workflowId}-ocr`, `${app.workflowId}-extraction`]) {
      const measured = await measureActivities(workflowId);
      queueDurations.push(...measured.queue); executionDurations.push(...measured.execution);
    }
    if (waitingReviews) {
      const description = await temporal.workflow.getHandle(app.workflowId, app.workflowRunId ?? undefined).describe();
      assert.equal(description.status.name, 'RUNNING', 'A human review must remain a durable open workflow');
      activeActivitiesAtReview += description.raw.pendingActivities?.length ?? 0;
      for (const suffix of ['-ocr', '-extraction']) {
        const child = await temporal.workflow.getHandle(`${app.workflowId}${suffix}`).describe();
        assert.equal(child.status.name, 'COMPLETED', 'Both processing children must finish before durable review waits');
        activeActivitiesAtReview += child.raw.pendingActivities?.length ?? 0;
      }
    }
  }
  assert.equal(duplicateFinalDecisions, 0);
  if (waitingReviews) assert.equal(activeActivitiesAtReview, 0, 'Open human reviews must occupy zero activity slots');
  resources.push(await sampleResources());
  return {
    workerReplicas: replicas, count, kind: waitingReviews ? 'open-human-reviews' : 'audited-pass', durationSeconds,
    throughputApplicationsPerSecond: count / durationSeconds,
    latencySeconds: { p50: latencies[Math.floor((count - 1) * 0.5)]!, p95: latencies[Math.floor((count - 1) * 0.95)]!, max: latencies.at(-1)! },
    applicationIds: submitted.map((entry) => entry.id), ...(waitingReviews ? { activeActivitiesAtReview } : {}),
    duplicateFinalDecisions, resources,
    activityScheduleToStartSeconds: summarize(queueDurations), activityExecutionSeconds: summarize(executionDurations),
    limits: {
      applicationWorkerCpu: 1, applicationWorkerMemoryMiB: 768, ocrWorkerCpu: 1, ocrWorkerMemoryMiB: 1024,
      extractionWorkerCpu: 1, extractionWorkerMemoryMiB: 768,
      ocrSlotsPerReplica: Number(process.env.OCR_ACTIVITY_SLOTS ?? 4), extractionSlotsPerReplica: Number(process.env.EXTRACTION_ACTIVITY_SLOTS ?? 4),
      admissionLimit: Number(process.env.MAX_ACTIVE_APPLICATIONS ?? 200),
    },
    notes: [
      'Educational fixture inference only; results do not measure live provider throughput.',
      cold
        ? 'Cold benchmark uses unique internal OCR and analysis revisions per application; actual rendering/OCR and fixture inference execute for each packet.'
        : 'Repeated byte-identical packets intentionally reuse successful immutable OCR/extraction artifacts; this measures cached end-to-end workflow throughput.',
      'Latency is observed through periodic API polling, including upload and queue delay.',
      'Temporal pending activity checks prove review waits consume zero activity slots at the observation point.',
      'Shared Temporal, PostgreSQL and object store capacity can limit scaling; replica count does not imply linear or unlimited throughput.',
    ],
  };
}

try {
  const reports: BatchReport[] = [];
  if (compare) {
    if (!cold) {
      const warmup = await client.upload(fixture);
      const warmed = await client.waitForApplication(warmup.applicationId, timeoutMs);
      assert.equal(warmed.status, 'PASS', 'Warm immutable artifacts before both cached comparison phases');
    }
    for (const replicas of [1, 3]) { await scale(replicas); reports.push(await batch(replicas)); }
  } else reports.push(await batch('existing'));
  await mkdir('.data/demo-results', { recursive: true });
  const path = `.data/demo-results/load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify({ educationalSimulation: true, mode: 'fixture', reports }, null, 2));
  console.log(JSON.stringify(reports.map(({ resources: _resources, applicationIds: _ids, ...report }) => report), null, 2));
  console.log(`Full measurements and application IDs: ${path}`);
  if (waitingReviews) console.log(`${count} cases remain open for the human review demonstration; elapsed time will not decide them.`);
} finally { await connection.close(); await database?.close(); objects?.close(); }
