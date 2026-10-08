import 'dotenv/config';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { PgStore } from '../src/storage.js';
import { recommendCapacity, resolveCapacityMode, workerServices, workerLimits, type CapacityObservation, type CapacitySettings, type CapacityTrend, type WorkerService } from '../src/capacity.js';

const run = promisify(execFile);
const args = process.argv.slice(2);
if (args.some((argument) => !['--apply', '--watch'].includes(argument))) throw new Error('Usage: npm run demo:capacity -- [--watch] [--apply]');
const apply = args.includes('--apply');
const watch = args.includes('--watch');
const queues: Record<WorkerService, string> = { 'application-worker': 'loan-applications', 'ocr-worker': 'document-ocr', 'extraction-worker': 'loan-extraction' };
const database = new PgStore();
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
const trends: Partial<Record<WorkerService, CapacityTrend>> = {};
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
const intervalSeconds = Number(process.env.CAPACITY_INTERVAL_SECONDS ?? 30);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 60) throw new Error('CAPACITY_INTERVAL_SECONDS must be 15–60.');
const positive = (value: string | undefined, fallback: number) => { const number = Number(value ?? fallback); if (!Number.isFinite(number) || number <= 0) throw new Error('Capacity budget/quota values must be positive.'); return number; };
const seconds = (duration: { seconds?: unknown; nanos?: number | null } | null | undefined) => duration ? Number(duration.seconds ?? 0) + (duration.nanos ?? 0) / 1e9 : 0;
const p95 = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * .95)]! : null;
const containsThrottle = (failure: unknown): boolean => /PROVIDER_429|rate.?limit|throttl/i.test(JSON.stringify(failure ?? null));

async function queueStats(name: string) {
  try {
    const response = await connection.withDeadline(Date.now() + 5_000, () => connection.workflowService.describeTaskQueue({ namespace: client.options.namespace,
      taskQueue: { name, kind: 1 }, apiMode: 1, taskQueueTypes: [1, 2], reportStats: true, reportPollers: true }));
    const types = Object.values(response.versionsInfo ?? {}).flatMap((version) => Object.values(version.typesInfo ?? {}));
    const stats = types.flatMap((type) => type.stats ? [type.stats] : []);
    if (stats.length) return { source: 'enhanced', backlog: stats.reduce((sum, stat) => sum + Number(stat.approximateBacklogCount ?? 0), 0),
      ageSeconds: Math.max(...stats.map((stat) => seconds(stat.approximateBacklogAge))),
      addRate: stats.reduce((sum, stat) => sum + (stat.tasksAddRate ?? 0), 0), dispatchRate: stats.reduce((sum, stat) => sum + (stat.tasksDispatchRate ?? 0), 0),
      pollers: types.reduce((sum, type) => sum + (type.pollers?.length ?? 0), 0) };
  } catch { /* Pinned server may support the current default API instead. */ }
  try {
    const responses = await Promise.all(([1, 2] as const).map((taskQueueType) => connection.withDeadline(Date.now() + 5_000, () => connection.workflowService.describeTaskQueue({
      namespace: client.options.namespace, taskQueue: { name, kind: 1 }, taskQueueType, reportStats: true }))));
    const stats = responses.flatMap((response) => response.stats ? [response.stats] : []);
    if (stats.length !== 2) throw new Error('No complete workflow/activity statistics.');
    return { source: 'default', backlog: stats.reduce((sum, stat) => sum + Number(stat.approximateBacklogCount ?? 0), 0), ageSeconds: Math.max(...stats.map((stat) => seconds(stat.approximateBacklogAge))),
      addRate: stats.reduce((sum, stat) => sum + (stat.tasksAddRate ?? 0), 0), dispatchRate: stats.reduce((sum, stat) => sum + (stat.tasksDispatchRate ?? 0), 0), pollers: responses.reduce((sum, response) => sum + (response.pollers?.length ?? 0), 0) };
  } catch { return { source: 'unavailable', backlog: null, ageSeconds: null, addRate: null, dispatchRate: null, pollers: null }; }
}

async function composeWorkers() {
  const counts: Record<WorkerService, number | null> = { 'application-worker': null, 'ocr-worker': null, 'extraction-worker': null };
  try {
    const output = await run('docker', ['compose', 'ps', '-q', ...workerServices], { timeout: 10_000 });
    const ids = output.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return { counts, fixedLimitsVerified: false, metrics: [], unavailable: 'No existing local Compose workers.' };
    const inspected = await run('docker', ['inspect', '--format', '{"service":"{{index .Config.Labels "com.docker.compose.service"}}","nanoCpu":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}}}', ...ids], { timeout: 10_000 });
    const limits = inspected.stdout.trim().split('\n').map((line) => JSON.parse(line) as { service: WorkerService; nanoCpu: number; memoryBytes: number });
    let verified = true;
    for (const service of workerServices) {
      const replicas = limits.filter((item) => item.service === service);
      counts[service] = replicas.length || null;
      verified &&= replicas.length > 0 && replicas.every((item) => item.nanoCpu === workerLimits[service].cpu * 1e9 && item.memoryBytes === workerLimits[service].memoryMiB * 1024 ** 2);
    }
    const sampled = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], { timeout: 10_000 });
    return { counts, fixedLimitsVerified: verified, metrics: sampled.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown), unavailable: null };
  } catch { return { counts, fixedLimitsVerified: false, metrics: [], unavailable: 'Docker worker counts/limits/CPU/memory metrics unavailable; no scaling is permitted.' }; }
}

async function snapshot() {
  const observed: Record<WorkerService, CapacityObservation & { historySampleExecutions: number; observedRetries: number }> = Object.fromEntries(workerServices.map((service) => [service, {
    backlog: null, backlogAgeSeconds: null, scheduleToStartP95Seconds: null, activeActivities: 0, providerThrottles: 0, historySampleExecutions: 0, observedRetries: 0,
  }])) as Record<WorkerService, CapacityObservation & { historySampleExecutions: number; observedRetries: number }>;
  const notes: string[] = [];
  try {
    let executions = 0;
    for await (const execution of client.workflow.list({ query: "ExecutionStatus = 'Running'", pageSize: 100 })) {
      if (++executions > 500) { notes.push('Active activity counts are a bounded 500-execution sample.'); break; }
      const service = workerServices.find((name) => queues[name] === execution.taskQueue);
      if (!service) continue;
      const description = await connection.withDeadline(Date.now() + 3_000, () => client.workflow.getHandle(execution.workflowId, execution.runId).describe());
      for (const activity of description.raw.pendingActivities ?? []) {
        if ([2, 3, 5].includes(activity.state ?? 0)) observed[service].activeActivities! += 1;
        if (containsThrottle(activity.lastFailure)) observed[service].providerThrottles += 1;
      }
    }
  } catch { notes.push('Active activity observations unavailable.'); for (const service of workerServices) observed[service].activeActivities = null; }
  for (const service of workerServices) {
    const waits: number[] = [];
    try {
      for await (const execution of client.workflow.list({ query: `TaskQueue = '${queues[service]}'`, pageSize: 10 })) {
        if (observed[service].historySampleExecutions >= 10) break;
        const history = await connection.withDeadline(Date.now() + 5_000, () => client.workflow.getHandle(execution.workflowId, execution.runId).fetchHistory());
        observed[service].historySampleExecutions += 1;
        const scheduled = new Map<string, number>();
        for (const event of history.events ?? []) {
          const time = seconds(event.eventTime);
          if (event.activityTaskScheduledEventAttributes) scheduled.set(String(event.eventId), time);
          const start = event.activityTaskStartedEventAttributes;
          if (start) {
            const enqueued = scheduled.get(String(start.scheduledEventId));
            if (enqueued !== undefined) waits.push(Math.max(0, time - enqueued));
            observed[service].observedRetries += Math.max(0, (start.attempt ?? 1) - 1);
            if (containsThrottle(start.lastFailure)) observed[service].providerThrottles += 1;
          }
          if (containsThrottle(event.activityTaskFailedEventAttributes?.failure)) observed[service].providerThrottles += 1;
        }
      }
      observed[service].scheduleToStartP95Seconds = p95(waits);
    } catch { notes.push(`${queues[service]} recent-history latency/retry sample unavailable.`); }
  }
  let activeLiveApplications: number | null = null;
  try {
    const result = await database.pool.query(`SELECT count(*)::integer AS active_live_applications
      FROM applications WHERE mode='live' AND audit_committed=false`);
    const count: unknown = result.rows[0]?.active_live_applications;
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) activeLiveApplications = count;
  } catch { /* Unknown workload mode always retains live provider quota guards. */ }
  if (activeLiveApplications === null) notes.push('Active live application mode observation unavailable; live provider quota guards are required.');
  let reviews: unknown = null;
  try {
    const result = await database.pool.query(`SELECT count(*)::integer AS open_cases,
      coalesce(max(extract(epoch FROM now()-opened_at)),0)::double precision AS oldest_age_seconds FROM review_cases WHERE status='OPEN'`);
    const failures = await database.pool.query(`SELECT count(*)::integer AS provider_throttle_events FROM audit_events WHERE occurred_at > now()-interval '15 minutes' AND payload::text ~* 'PROVIDER_429|throttl'`);
    reviews = result.rows[0];
    observed['extraction-worker'].providerThrottles += failures.rows[0]?.provider_throttle_events ?? 0;
  } catch { notes.push('PostgreSQL review-age/provider-failure summary unavailable.'); }
  const resources = await composeWorkers();
  const stats = await Promise.all(workerServices.map(async (service) => [service, await queueStats(queues[service])] as const));
  const modeSignals = { configuredMode: process.env.MODE === 'live' ? 'live' as const : 'fixture' as const,
    modelKeyConfigured: Boolean(process.env.MODEL_API_KEY), activeLiveApplications };
  const settings: CapacitySettings = { mode: resolveCapacityMode(modeSignals), cpuBudget: positive(process.env.CAPACITY_CPU_BUDGET, 9),
    memoryBudgetMiB: positive(process.env.CAPACITY_MEMORY_MIB_BUDGET, 8192), extractionSlots: positive(process.env.EXTRACTION_ACTIVITY_SLOTS, 4),
    providerConcurrencyQuota: process.env.MODEL_MAX_CONCURRENT_REQUESTS ? positive(process.env.MODEL_MAX_CONCURRENT_REQUESTS, 1) : null,
    fixedLimitsVerified: resources.fixedLimitsVerified };
  const recommendations = [];
  const proposed = { ...resources.counts };
  for (const [service, queue] of stats) {
    observed[service].backlog = queue.backlog;
    observed[service].backlogAgeSeconds = queue.ageSeconds;
    const recommendation = recommendCapacity(service, proposed, observed[service], settings, trends[service]);
    trends[service] = recommendation.trend;
    recommendations.push(recommendation);
    if (recommendation.targetReplicas !== null) proposed[service] = recommendation.targetReplicas;
  }
  if (apply && recommendations.some((recommendation) => recommendation.action !== 'HOLD')) {
    // Only existing local worker services, never build/pull/start infrastructure or resize a worker.
    await run('docker', ['compose', 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', ...workerServices.flatMap((service) => ['--scale', `${service}=${proposed[service]}`]), ...workerServices], { timeout: 60_000 });
  }
  const report = { timestamp: new Date().toISOString(), educationalSimulation: true, mode: settings.mode, modeSignals, apply, settings,
    taskQueues: Object.fromEntries(stats), observations: observed, reviews, resources, recommendations,
    notes: [...notes, 'Backlog metrics are approximate; workflow sticky tasks and eager activities are not fully represented.',
      'Retries/throttling and latency use up to ten recent execution histories per queue; activity retry details can be compacted by Temporal.',
      'Open human reviews do not themselves request more activity slots. CPU alone never requests scale-up.'] };
  await mkdir('.data/demo-results', { recursive: true });
  await writeFile('.data/demo-results/capacity-latest.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

try {
  do { await snapshot(); if (!watch || stopping) break; await delay(intervalSeconds * 1000); } while (!stopping);
} finally { await connection.close(); await database.close(); }
