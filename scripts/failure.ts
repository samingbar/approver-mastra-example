import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import { artifactRefSchema, type ArtifactRef } from '../src/contracts.js';
import { loadFixtureManifest, readFixtureBytes } from '../src/fixtures/index.js';
import { DEMO_POLICY } from '../src/policy.js';
import { ArtifactStore, PgStore, hashBytes } from '../src/storage.js';
import type { ApplicationInput } from '../src/workflows/application-contract.js';

interface ActivityCheckpoint {
  scheduledEventId: string;
  activityId: string;
  type: string;
  input: unknown;
  result: unknown;
  completed: boolean;
  started: boolean;
  attempt: number;
}

function decode(payload: { data?: Uint8Array | null } | null | undefined): unknown {
  return payload?.data?.length ? JSON.parse(Buffer.from(payload.data).toString('utf8')) as unknown : undefined;
}

async function activityCheckpoints(handle: WorkflowHandle): Promise<ActivityCheckpoint[]> {
  const history = await handle.fetchHistory();
  const scheduled = new Map<string, ActivityCheckpoint>();
  for (const event of history.events ?? []) {
    const created = event.activityTaskScheduledEventAttributes;
    if (created) scheduled.set(String(event.eventId), {
      scheduledEventId: String(event.eventId), activityId: created.activityId ?? '', type: created.activityType?.name ?? '',
      input: decode(created.input?.payloads?.[0]), result: undefined,
      completed: false, started: false, attempt: 0,
    });
    const started = event.activityTaskStartedEventAttributes;
    if (started) {
      const checkpoint = scheduled.get(String(started.scheduledEventId));
      if (checkpoint) { checkpoint.started = true; checkpoint.attempt = started.attempt ?? 1; }
    }
    const completed = event.activityTaskCompletedEventAttributes;
    if (completed) {
      const checkpoint = scheduled.get(String(completed.scheduledEventId));
      if (checkpoint) { checkpoint.completed = true; checkpoint.result = decode(completed.result?.payloads?.[0]); }
    }
  }
  // Intermediate retry starts may be transient rather than committed history events.
  const description = await handle.describe();
  for (const pending of description.raw.pendingActivities ?? []) {
    const checkpoint = [...scheduled.values()].find((item) => item.activityId === pending.activityId);
    if (checkpoint && pending.lastStartedTime) {
      checkpoint.started = true;
      checkpoint.attempt = pending.attempt ?? 1;
    }
  }
  return [...scheduled.values()];
}

async function waitUntil<T>(check: () => Promise<T | undefined>, description: string, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}. Inspect the application in Temporal UI.`);
}

async function command(executable: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-8_000); });
    child.stderr.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString()}`.slice(-8_000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} exited ${String(code)}: ${errors}`)));
  });
}

function pageNumber(checkpoint: ActivityCheckpoint): number | undefined {
  const input = checkpoint.input as { page?: { pageNumber?: number } } | undefined;
  return input?.page?.pageNumber;
}

async function main(): Promise<void> {
  if ((process.env.MODE ?? 'fixture') !== 'fixture') throw new Error('The failure walkthrough requires local fixture mode.');
  await command('docker', ['compose', 'ps', '--status', 'running']);
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const artifacts = new ArtifactStore();
  const database = new PgStore();
  const runId = randomUUID();
  const temporaryContainers = new Set<string>();
  const report: Record<string, unknown>[] = [];
  const fixture = (await loadFixtureManifest()).fixtures.find((entry) => entry.id === 'pass');
  assert(fixture);
  const bytes = await readFixtureBytes('pass');
  const document = await artifacts.putImmutable(`documents/${fixture.sha256}.pdf`, bytes, 'application/pdf');
  const startedApplications: string[] = [];

  async function startApplication(label: string) {
    const applicationId = randomUUID();
    const workflowId = `loan-${applicationId}`;
    const input: ApplicationInput = {
      applicationId, document, documentHash: fixture!.sha256, mode: 'fixture', policy: DEMO_POLICY,
      revision: 1, ocrVersion: `failure-${runId}-${label}`,
      analysisRevision: `loan-evidence-v1:fixture:failure-${runId}-${label}`,
    };
    await database.createApplication({ id: applicationId, documentKey: document.key, documentHash: input.documentHash,
      mode: 'fixture', workflowId, policyVersion: DEMO_POLICY.version, policyHash: DEMO_POLICY.hash,
      data: { educationalSimulation: true, failureWalkthrough: label, sourceVerifiedFixture: true } });
    const handle = await client.workflow.start('loanApplicationWorkflow', { workflowId, taskQueue: 'loan-applications', args: [input] });
    startedApplications.push(applicationId);
    await database.updateApplication(applicationId, { workflowRunId: handle.firstExecutionRunId });
    return { applicationId, workflowId, handle,
      ocr: client.workflow.getHandle(`${workflowId}-ocr`), extraction: client.workflow.getHandle(`${workflowId}-extraction`) };
  }

  async function specialWorker(service: 'ocr-worker' | 'extraction-worker', environment: Record<string, string>) {
    await command('docker', ['compose', 'stop', service]);
    const name = `loan-failure-${service}-${randomUUID()}`;
    const args = ['compose', 'run', '-d', '--no-deps', '--name', name];
    for (const [key, value] of Object.entries(environment)) args.push('-e', `${key}=${value}`);
    args.push(service);
    await command('docker', args);
    temporaryContainers.add(name);
    return name;
  }

  async function killAndRestore(container: string, service: 'ocr-worker' | 'extraction-worker') {
    await command('docker', ['kill', '--signal', 'SIGKILL', container]);
    await command('docker', ['rm', container]);
    temporaryContainers.delete(container);
    await command('docker', ['compose', 'up', '-d', '--no-deps', service]);
  }

  async function finalAudit(applicationId: string, expected: string) {
    const audit = await waitUntil(async () => {
      const record = await database.getAudit(applicationId);
      return record?.application.auditCommitted ? record : undefined;
    }, `committed ${expected} audit`);
    assert.equal(audit.application.status, expected);
    assert.equal(audit.events.filter((event) => event.type === 'FINAL_COMMITTED').length, 1, 'Exactly one final audit event is required.');
    return audit;
  }

  async function historyReady(handle: WorkflowHandle, predicate: (checkpoints: ActivityCheckpoint[]) => boolean) {
    return await waitUntil(async () => {
      try {
        const checkpoints = await activityCheckpoints(handle);
        return predicate(checkpoints) ? checkpoints : undefined;
      } catch (error) {
        if (error instanceof Error && error.name === 'WorkflowNotFoundError') return undefined;
        // fetchHistory uses the raw gRPC NOT_FOUND while the parent is still
        // committing its upload progress and has not started the child yet.
        if (error && typeof error === 'object' && 'code' in error && error.code === 5) return undefined;
        throw error;
      }
    }, 'activity checkpoint');
  }

  try {
    console.log('Educational simulation: interrupting only the local Compose OCR/extraction workers.');
    const ocrContainer = await specialWorker('ocr-worker', { MODE: 'fixture', OCR_TEST_DELAY_MS: '45000' });
    const ocrCase = await startApplication('ocr-kill');
    const before = await historyReady(ocrCase.ocr, (checkpoints) => checkpoints.some((checkpoint) => checkpoint.type === 'ocrPage' && checkpoint.completed)
      && checkpoints.some((checkpoint) => checkpoint.type === 'ocrPage' && pageNumber(checkpoint) === 2 && checkpoint.started && !checkpoint.completed));
    const completedPages = before.filter((checkpoint) => checkpoint.type === 'ocrPage' && checkpoint.completed).map((checkpoint) => {
      const result = checkpoint.result as { artifact: ArtifactRef };
      return { page: pageNumber(checkpoint), artifact: artifactRefSchema.parse(result.artifact) };
    });
    await killAndRestore(ocrContainer, 'ocr-worker');
    await database.recordEvent({ applicationId: ocrCase.applicationId, eventId: `${ocrCase.applicationId}:demo:ocr-interrupted`,
      type: 'TECHNICAL_RECOVERY', actorType: 'operator', actorId: 'local-failure-walkthrough',
      payload: { stage: 'ocr', signal: 'SIGKILL', completedPages: completedPages.map((entry) => entry.page), pendingPage: 2 } });
    const ocrFinal = await finalAudit(ocrCase.applicationId, 'PASS');
    const after = await activityCheckpoints(ocrCase.ocr);
    for (const completed of completedPages) {
      assert.equal(hashBytes(await artifacts.getBytes(completed.artifact.key)), completed.artifact.sha256);
      assert.equal(after.filter((checkpoint) => checkpoint.type === 'ocrPage' && pageNumber(checkpoint) === completed.page).length, 1);
    }
    assert((after.find((checkpoint) => checkpoint.type === 'ocrPage' && pageNumber(checkpoint) === 2)?.attempt ?? 0) >= 2);
    report.push({ scenario: 'ocr-worker-SIGKILL', applicationId: ocrCase.applicationId, status: ocrFinal.application.status,
      retainedPages: completedPages, activityAttempts: after.map(({ type, attempt }) => ({ type, attempt })) });
    console.log(`OCR recovered; ${completedPages.length} completed pages retained. Application ${ocrCase.applicationId}`);

    const extractionContainer = await specialWorker('extraction-worker', { MODE: 'fixture', EXTRACTION_VALIDATE_DELAY_MS: '45000' });
    const extractionCase = await startApplication('extraction-kill');
    const generatedBefore = await historyReady(extractionCase.extraction, (checkpoints) => checkpoints.some((checkpoint) => checkpoint.type === 'extractRelevantFacts' && checkpoint.completed)
      && checkpoints.some((checkpoint) => checkpoint.type === 'validateAndSaveEvidence' && checkpoint.started && !checkpoint.completed));
    const draft = artifactRefSchema.parse((generatedBefore.find((checkpoint) => checkpoint.type === 'extractRelevantFacts')!.result as { draftRef: unknown }).draftRef);
    await killAndRestore(extractionContainer, 'extraction-worker');
    await database.recordEvent({ applicationId: extractionCase.applicationId, eventId: `${extractionCase.applicationId}:demo:extraction-interrupted`,
      type: 'TECHNICAL_RECOVERY', actorType: 'operator', actorId: 'local-failure-walkthrough', artifactRefs: [draft],
      payload: { stage: 'extraction', signal: 'SIGKILL', completedStep: 'extractRelevantFacts' } });
    const extractionFinal = await finalAudit(extractionCase.applicationId, 'PASS');
    const generatedAfter = await activityCheckpoints(extractionCase.extraction);
    assert.equal(generatedAfter.filter((checkpoint) => checkpoint.type === 'extractRelevantFacts').length, 1);
    assert.equal(hashBytes(await artifacts.getBytes(draft.key)), draft.sha256);
    assert((generatedAfter.find((checkpoint) => checkpoint.type === 'validateAndSaveEvidence')?.attempt ?? 0) >= 2);
    report.push({ scenario: 'generated-worker-SIGKILL', applicationId: extractionCase.applicationId,
      status: extractionFinal.application.status, retainedDraft: draft,
      activityAttempts: generatedAfter.map(({ type, attempt }) => ({ type, attempt })) });
    console.log(`Generated Mastra child recovered with its first step retained. Application ${extractionCase.applicationId}`);

    for (const [label, failures, expected, failureCode] of [
      ['provider-429-retry', '2', 'PASS', 'PROVIDER_429'],
      ['provider-429-exhausted', '3', 'PROCESSING_ERROR', 'PROVIDER_429'],
      ['provider-timeout-retry', '2', 'PASS', 'PROVIDER_TIMEOUT'],
      ['provider-timeout-exhausted', '3', 'PROCESSING_ERROR', 'PROVIDER_TIMEOUT'],
    ] as const) {
      const container = await specialWorker('extraction-worker', { MODE: 'fixture', EXTRACTION_FAIL_ATTEMPTS: failures, EXTRACTION_FAILURE_CODE: failureCode });
      const application = await startApplication(label);
      const audit = await finalAudit(application.applicationId, expected);
      const checkpoints = await activityCheckpoints(application.extraction);
      const observedAttempt = checkpoints.find((checkpoint) => checkpoint.type === 'extractRelevantFacts')?.attempt ?? 0;
      assert(observedAttempt >= 3);
      await database.recordEvent({ applicationId: application.applicationId,
        eventId: `${application.applicationId}:demo:${label}`, type: expected === 'PASS' ? 'TECHNICAL_RECOVERY' : 'PROCESSING_FAILURE_SUMMARY',
        actorType: 'operator', actorId: 'local-failure-walkthrough',
        payload: { stage: 'extraction', failureCode, faultSource: 'declared fixture provider error',
          observedAttempt, resultingStatus: audit.application.status, workflowId: `${application.workflowId}-extraction` } });
      await command('docker', ['stop', container]);
      await command('docker', ['rm', container]);
      temporaryContainers.delete(container);
      await command('docker', ['compose', 'up', '-d', '--no-deps', 'extraction-worker']);
      report.push({ scenario: label, applicationId: application.applicationId, status: audit.application.status,
        failureCode, faultSource: 'declared fixture provider error',
        activityAttempts: checkpoints.map(({ type, attempt }) => ({ type, attempt })) });
      console.log(`${label}: ${audit.application.status}. Application ${application.applicationId}`);
    }
    await mkdir('.data/demo-results', { recursive: true });
    await writeFile(`.data/demo-results/failure-${runId}.json`, JSON.stringify({ educationalSimulation: true, runId, report }, null, 2));
    console.log(`Verified six failure scenarios. Report: .data/demo-results/failure-${runId}.json`);
  } finally {
    for (const container of temporaryContainers) await command('docker', ['rm', '-f', container]).catch(() => undefined);
    await command('docker', ['compose', 'up', '-d', '--no-deps', 'ocr-worker', 'extraction-worker']).catch(() => undefined);
    for (const applicationId of startedApplications) {
      const projection = await database.getApplication(applicationId);
      if (projection && !projection.auditCommitted) await client.workflow.getHandle(projection.workflowId).cancel().catch(() => undefined);
    }
    await connection.close(); await database.close(); artifacts.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Failure walkthrough failed.');
  process.exitCode = 1;
});
