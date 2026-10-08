import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApi, MAX_UPLOAD_BYTES, ReviewRejectedError, WorkflowStartRejectedError, WorkflowStartUnconfirmedError, type ApiArtifacts, type ApiDatabase, type ApiWorkflowClient, type ApplicationView, type ReviewCommand } from '../src/api/app.js';
import { readApiConfig } from '../src/api/config.js';
import type { CommandAuditInput, CreateApplicationInput, ApplicationPatch, FinalCommitInput, AuditEventInput, CommandAudit } from '../src/storage.js';
import { DEMO_POLICY, canonicalJson } from '../src/policy.js';
import { createPasswordHash, passwordSessions, type ReviewerIdentity } from '../src/api/auth.js';
import type { ApplicationState } from '../src/workflows/application-contract.js';
import { fieldNames, rawExtractionSchema } from '../src/contracts.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function databaseFixture() {
  const applications = new Map<string, ApplicationView>();
  const commands: CommandAuditInput[] = [];
  const events: AuditEventInput[] = [];
  const sessions = new Map<string, { identity: ReviewerIdentity; expiresAt: string }>();
  const database: ApiDatabase = {
    async createApplication(input: CreateApplicationInput) {
      const application: ApplicationView = {
        ...input, workflowRunId: input.workflowRunId ?? null, parentApplicationId: input.parentApplicationId ?? null,
        data: input.data ?? {}, revision: input.revision ?? 1, stage: 'uploaded', status: 'UPLOADED',
        evidenceRevision: 1, auditCommitted: false, createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z',
      };
      applications.set(input.id, application);
      return application;
    },
    async getApplication(id) { return applications.get(id) ?? null; },
    async listApplications() { return [...applications.values()]; },
    async updateApplication(id: string, patch: ApplicationPatch) {
      const application = applications.get(id)!;
      Object.assign(application, patch);
      return application;
    },
    async getReviewCase() { return null; },
    async listReviewCases() { return []; },
    async getAudit(id) { return { application: applications.get(id), events: [], commands }; },
    async recordCommand(input) { commands.push(input); return input; },
    async getCommand(applicationId, commandId) {
      const previous = commands.find((input) => input.applicationId === applicationId && input.commandId === commandId);
      return previous ? { ...previous, statusCode: previous.statusCode ?? 202, createdAt: '2026-10-06T00:00:00Z' } as CommandAudit : null;
    },
    async recordEvent(input) { events.push(input); return input; },
    async putReviewerSession(input) { sessions.set(input.tokenHash, { identity: input.identity, expiresAt: input.expiresAt }); },
    async getReviewerSession(hash) { return sessions.get(hash) ?? null; },
    async deleteReviewerSession(hash) { sessions.delete(hash); },
    async commitFinal(input: FinalCommitInput) {
      const application = applications.get(input.applicationId)!;
      application.status = input.status;
      application.auditCommitted = true;
      return application;
    },
  };
  return { database, applications, commands, events, sessions };
}

async function harness(options: { mode?: 'fixture' | 'live'; knownFixtureHashes?: ReadonlySet<string>; allow?: readonly string[] } = {}) {
  const { database, applications, commands, events, sessions } = databaseFixture();
  const objects = new Map<string, Buffer>();
  const artifacts: ApiArtifacts = {
    async putImmutable(key, bytes, contentType) {
      if (objects.has(key) && !objects.get(key)!.equals(bytes)) throw new Error('Immutable artifact conflict');
      objects.set(key, bytes);
      return { key, sha256: createHash('sha256').update(bytes).digest('hex'), contentType, size: bytes.length };
    },
    async getBytes(key) { return objects.get(key)!; },
    async getJson<T>(key: string) { return JSON.parse(objects.get(key)!.toString('utf8')) as T; },
    async putJsonImmutable(key, value) { return this.putImmutable(key, Buffer.from(canonicalJson(value)), 'application/json'); },
  };
  const results = new Map<string, Awaited<ReturnType<ApiWorkflowClient['submitReview']>>>();
  const startApplication = vi.fn(async (_input: Parameters<ApiWorkflowClient['startApplication']>[0], _workflowId: string) => ({ runId: randomUUID() }));
  const submitReview = vi.fn(async (command: ReviewCommand) => {
    const previous = results.get(command.commandId);
    if (previous) return previous;
    const accepted = command.caseRevision === 1;
    const result: Awaited<ReturnType<ApiWorkflowClient['submitReview']>> = { accepted, commandId: command.commandId, caseRevision: accepted ? 2 : 1, evidenceRevision: 1, status: accepted ? 'SAVING' : 'REVIEW' };
    results.set(command.commandId, result);
    return result;
  });
  const config = readApiConfig({ APP_MODE: options.mode ?? 'fixture' });
  const app = await createApi({
    config, database, artifacts, workflows: { startApplication, submitReview }, knownFixtureHashes: options.knownFixtureHashes,
    ...(options.mode === 'live' ? { authenticate: async () => ({ id: 'real-reviewer', displayName: 'Authenticated reviewer', role: 'reviewer' as const, applicationIds: options.allow ?? [] }) } : {}),
  });
  apps.push(app);
  await app.ready();
  return { app, database, artifacts, applications, commands, events, sessions, objects, startApplication, submitReview };
}

async function login(app: FastifyInstance, reviewerId = 'demo-reviewer'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/session', payload: { reviewerId } });
  expect(response.statusCode).toBe(200);
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies[0]! : cookies!).split(';')[0]!;
}

function packet(bytes: Buffer, fields: Record<string, string> = {}) {
  const boundary = 'local-pdf-test-boundary';
  const parts: Buffer[] = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="fictitious.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

const minimalPacket = Buffer.from('%PDF-1.4\nSynthetic test packet; format/page checks happen in OCR.\n%%EOF');

async function upload(app: FastifyInstance, cookie: string, bytes: Buffer = minimalPacket, fields: Record<string, string> = {}) {
  const form = packet(bytes, fields);
  return app.inject({ method: 'POST', url: '/api/applications', payload: form.payload, headers: { ...form.headers, cookie } });
}

function command(application: ApplicationView, extra: Record<string, unknown> = {}) {
  return {
    commandId: randomUUID(), applicationId: application.id, workflowId: application.workflowId,
    workflowRunId: application.workflowRunId, caseRevision: 1, evidenceRevision: 1,
    policyVersion: application.policyVersion, action: 'FINALIZE', decision: 'PASS', note: 'Reviewed the cited synthetic evidence.', ...extra,
  };
}

describe('local review HTTP boundary', () => {
  it('stages one bounded PDF and starts Temporal, returning 202 without doing analysis', async () => {
    const hash = createHash('sha256').update(minimalPacket).digest('hex');
    const h = await harness({ knownFixtureHashes: new Set([hash]) });
    const cookie = await login(h.app);
    const response = await upload(h.app, cookie);
    expect(response.statusCode).toBe(202);
    const id = response.json<{ applicationId: string }>().applicationId;
    const application = h.applications.get(id)!;
    expect(application.documentHash).toBe(hash);
    expect(application.data['sourceVerifiedFixture']).toBe(true);
    expect(application.policyHash).toBe(DEMO_POLICY.hash);
    expect(h.objects.get(application.documentKey)).toEqual(minimalPacket);
    expect(h.startApplication).toHaveBeenCalledTimes(1);
    expect(h.startApplication.mock.calls[0]?.[0]).toMatchObject({ applicationId: id, mode: 'fixture', documentHash: hash });
  });

  it('does not trust PDF extension, fixture label or oversized packets', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    expect((await upload(h.app, cookie, Buffer.from('not a PDF'))).statusCode).toBe(400);
    expect((await upload(h.app, cookie, minimalPacket, { fixture: 'pass' })).statusCode).toBe(400);
    const large = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 32);
    Buffer.from('%PDF-1.4').copy(large);
    expect((await upload(h.app, cookie, large)).statusCode).toBe(413);
    expect(h.startApplication).not.toHaveBeenCalled();
    const accepted = await upload(h.app, cookie);
    expect(accepted.statusCode).toBe(202);
    expect(h.applications.get(accepted.json<{ applicationId: string }>().applicationId)?.data['sourceVerifiedFixture']).toBe(false);
  });

  it('requires a server session and rejects browser cross-origin commands and hostile hosts', async () => {
    const h = await harness();
    expect((await upload(h.app, '')).statusCode).toBe(401);
    const response = await h.app.inject({ method: 'POST', url: '/api/session', headers: { origin: 'https://attacker.invalid' }, payload: { reviewerId: 'demo-reviewer' } });
    expect(response.statusCode).toBe(403);
    const hostile = await h.app.inject({ method: 'GET', url: '/api/config', headers: { host: 'attacker.invalid' } });
    expect(hostile.statusCode).toBe(403);
  });

  it('shares only hashed opaque sessions across API restarts and replicas', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const rawToken = cookie.split('=')[1]!;
    expect(h.sessions.has(rawToken)).toBe(false);
    expect([...h.sessions.keys()]).toEqual([createHash('sha256').update(rawToken).digest('hex')]);
    const replica = await createApi({
      config: readApiConfig({ MODE: 'fixture' }), database: h.database,
      artifacts: { putImmutable: vi.fn(), putJsonImmutable: vi.fn(), getBytes: vi.fn(), getJson: vi.fn() },
      workflows: { startApplication: h.startApplication, submitReview: h.submitReview },
    });
    apps.push(replica);
    const resumed = await replica.inject({ url: '/api/session', headers: { cookie } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ identity: { id: 'demo-reviewer', role: 'reviewer' } });
    const stored = [...h.sessions.values()][0]!;
    stored.expiresAt = '1970-01-01T00:00:00.000Z';
    expect((await replica.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(401);
    expect(h.sessions.size).toBe(0);
  });

  it('derives actor identity from the session and rejects spoofed actor JSON', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const created = await upload(h.app, cookie);
    const application = h.applications.get(created.json<{ applicationId: string }>().applicationId)!;
    const spoofed = await h.app.inject({ method: 'POST', url: `/api/reviews/${application.id}/commands`, headers: { cookie }, payload: command(application, { actorId: 'admin', reviewerId: 'admin' }) });
    expect(spoofed.statusCode).toBe(400);
    expect(h.commands.at(-1)).toMatchObject({ reviewerId: 'demo-reviewer', status: 'rejected' });
    expect(h.submitReview).not.toHaveBeenCalled();
    const accepted = await h.app.inject({ method: 'POST', url: `/api/reviews/${application.id}/commands`, headers: { cookie }, payload: command(application) });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ status: 'SAVING', educationalSimulation: true });
    expect(h.submitReview.mock.calls[0]?.[0]).toMatchObject({ actorId: 'demo-reviewer', actorRole: 'reviewer' });
  });

  it('keeps arbitrary notes and full cited corrections in immutable objects outside Temporal commands', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const uploaded = await upload(h.app, cookie);
    const application = h.applications.get(uploaded.json<{ applicationId: string }>().applicationId)!;
    const marker = 'FICTITIOUS PERSONAL IDENTIFIER 12345';
    const citation = { page: 1, blockId: 'identity-fixture-block', quote: marker, boundingBox: { x: 1, y: 2, width: 30, height: 10 } };
    const corrections = rawExtractionSchema.parse({
      fields: Object.fromEntries(fieldNames.map((name) => [name, { value: null, unit: null, period: null, citations: [citation], conflictingValues: [] }])),
      debtExcludesProposedLoan: null, cashPriceExcludesExtras: null, fixedApr: null, notes: [],
    });
    const payload = command(application, { action: 'CORRECT', decision: undefined, note: marker, corrections });
    const response = await h.app.inject({ method: 'POST', url: `/api/reviews/${application.id}/commands`, headers: { cookie }, payload });
    expect(response.statusCode).toBe(202);
    const temporalCommand = h.submitReview.mock.calls[0]![0];
    expect(temporalCommand).toMatchObject({ contentRef: { contentType: 'application/json' }, action: 'CORRECT' });
    expect(temporalCommand).not.toHaveProperty('note');
    expect(temporalCommand).not.toHaveProperty('corrections');
    expect(JSON.stringify(temporalCommand)).not.toContain(marker);
    const content = JSON.parse(h.objects.get(temporalCommand.contentRef.key)!.toString('utf8')) as { note: string; corrections: unknown };
    expect(content).toMatchObject({ note: marker, corrections });
    expect(createHash('sha256').update(h.objects.get(temporalCommand.contentRef.key)!).digest('hex')).toBe(temporalCommand.contentRef.sha256);
  });

  it('does not submit an Update when staging fails and keeps the same command retryable', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const uploaded = await upload(h.app, cookie);
    const application = h.applications.get(uploaded.json<{ applicationId: string }>().applicationId)!;
    const payload = command(application);
    const stage = h.artifacts.putJsonImmutable.bind(h.artifacts);
    vi.spyOn(h.artifacts, 'putJsonImmutable').mockImplementationOnce(stage).mockRejectedValueOnce(new Error('Object storage unavailable'));
    const send = (body = payload) => h.app.inject({ method: 'POST', url: `/api/reviews/${application.id}/commands`, headers: { cookie }, payload: body });
    const failed = await send();
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ commandId: payload.commandId, code: 'REVIEW_CONTENT_STAGING_UNAVAILABLE', accepted: null });
    expect(h.submitReview).not.toHaveBeenCalled();
    expect(h.commands).toHaveLength(0);
    expect((await send({ ...payload, note: 'Changed intent after staging' })).statusCode).toBe(409);
    expect(h.submitReview).not.toHaveBeenCalled();
    expect((await send()).statusCode).toBe(202);
    expect(h.submitReview).toHaveBeenCalledTimes(1);
    expect(h.submitReview.mock.calls[0]?.[0].commandId).toBe(payload.commandId);
  });

  it('binds commands to workflow/run/policy and separately authorizes override actions', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const created = await upload(h.app, cookie);
    const application = h.applications.get(created.json<{ applicationId: string }>().applicationId)!;
    const send = (payload: ReturnType<typeof command>, session = cookie) => h.app.inject({ method: 'POST', url: `/api/reviews/${application.id}/commands`, headers: { cookie: session }, payload });
    expect((await send(command(application, { workflowRunId: randomUUID() }))).statusCode).toBe(409);
    expect((await send(command(application, { action: 'OVERRIDE' }))).statusCode).toBe(403);
    expect(h.commands).toHaveLength(2);
    expect(h.submitReview).not.toHaveBeenCalled();
    const supervisor = await login(h.app, 'demo-supervisor');
    expect((await send(command(application, { action: 'OVERRIDE' }), supervisor)).statusCode).toBe(202);
    expect(h.submitReview.mock.calls[0]?.[0]).toMatchObject({ action: 'OVERRIDE', actorRole: 'override-reviewer' });
  });

  it('returns 409 and records stale native Updates; repeats use the same command ID', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const created = await upload(h.app, cookie);
    const application = h.applications.get(created.json<{ applicationId: string }>().applicationId)!;
    const url = `/api/reviews/${application.id}/commands`;
    const stale = await h.app.inject({ method: 'POST', url, headers: { cookie }, payload: command(application, { caseRevision: 2 }) });
    expect(stale.statusCode).toBe(409);
    expect(h.commands.at(-1)?.status).toBe('rejected');
    const payload = command(application);
    const first = await h.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    const repeated = await h.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    expect(first.json()).toEqual(repeated.json());
    expect(h.submitReview.mock.calls.at(-1)?.[0].commandId).toBe(payload.commandId);
  });

  it('keeps lost Update acknowledgements retryable and rejects altered duplicate content', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const created = await upload(h.app, cookie);
    const application = h.applications.get(created.json<{ applicationId: string }>().applicationId)!;
    const payload = command(application);
    const send = (body = payload) => h.app.inject({ method: 'POST', url: `/api/reviews/${application.id}/commands`, headers: { cookie }, payload: body });
    h.submitReview.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    const unconfirmed = await send();
    expect(unconfirmed.statusCode).toBe(503);
    expect(unconfirmed.json()).toMatchObject({ accepted: null, status: 'SAVING', commandId: payload.commandId });
    expect(h.commands).toHaveLength(0);
    expect(h.events.at(-1)?.type).toBe('REVIEW_UPDATE_ACKNOWLEDGEMENT_UNCONFIRMED');
    const retried = await send();
    expect(retried.statusCode).toBe(202);
    const beforeDuplicate = h.submitReview.mock.calls.length;
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as ReturnType<typeof command>;
    expect((await send(reordered)).json()).toEqual(retried.json());
    expect(h.submitReview.mock.calls).toHaveLength(beforeDuplicate);
    expect((await send({ ...payload, note: 'Different reviewer intent' })).statusCode).toBe(409);
    expect(h.events.at(-1)?.payload?.['code']).toBe('COMMAND_CONFLICT');
    h.submitReview.mockRejectedValueOnce(new ReviewRejectedError('Closed workflow'));
    expect((await send(command(application))).statusCode).toBe(409);
    expect(h.commands.at(-1)?.status).toBe('rejected');
  });

  it('protects PDFs and limits live identities to explicitly authorized cases', async () => {
    const fixture = await harness();
    const cookie = await login(fixture.app);
    const created = await upload(fixture.app, cookie);
    const application = fixture.applications.get(created.json<{ applicationId: string }>().applicationId)!;
    expect((await fixture.app.inject(`/api/applications/${application.id}/document`)).statusCode).toBe(401);
    const served = await fixture.app.inject({ url: `/api/applications/${application.id}/document`, headers: { cookie } });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(minimalPacket);
    const live = await harness({ mode: 'live' });
    live.applications.set(application.id, application);
    expect((await live.app.inject(`/api/applications/${application.id}`)).statusCode).toBe(404);
    expect((await live.app.inject('/api/applications')).json()).toEqual({ applications: [] });
    expect((await live.app.inject({ method: 'POST', url: '/api/session', payload: { reviewerId: 'demo-reviewer' } })).statusCode).toBe(404);
  });

  it('refuses live fixture authentication and saves an auditable technical start error', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    h.startApplication.mockRejectedValueOnce(new WorkflowStartRejectedError('Temporal unauthorized'));
    const response = await upload(h.app, cookie);
    expect(response.statusCode).toBe(503);
    const application = h.applications.get(response.json<{ applicationId: string }>().applicationId)!;
    expect(application).toMatchObject({ status: 'PROCESSING_ERROR', auditCommitted: true });
    await expect(createApi({ config: readApiConfig({ APP_MODE: 'live' }), database: h.database, artifacts: { putImmutable: vi.fn(), putJsonImmutable: vi.fn(), getBytes: vi.fn(), getJson: vi.fn() }, workflows: { startApplication: h.startApplication, submitReview: h.submitReview } })).rejects.toThrow('real server-side authenticator');
  });

  it('preserves an unconfirmed start and resumes the same application/workflow without a revision', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    h.startApplication.mockRejectedValueOnce(new WorkflowStartUnconfirmedError('Lost start acknowledgement'));
    const response = await upload(h.app, cookie);
    expect(response.statusCode).toBe(202);
    const applicationId = response.json<{ applicationId: string }>().applicationId;
    expect(response.json()).toMatchObject({ stage: 'START_PENDING', startUnconfirmed: true });
    const application = h.applications.get(applicationId)!;
    expect(application.auditCommitted).toBe(false);
    expect(h.events.at(-1)?.type).toBe('START_UNCONFIRMED');
    const resumed = await h.app.inject({ method: 'POST', url: `/api/applications/${applicationId}/resume`, headers: { cookie } });
    expect(resumed.statusCode).toBe(202);
    expect(h.startApplication).toHaveBeenCalledTimes(2);
    expect(h.startApplication.mock.calls[0]).toEqual(h.startApplication.mock.calls[1]);
    expect(h.applications.size).toBe(1);
    expect(application.revision).toBe(1);
    expect(application.workflowRunId).toBeTruthy();
  });

  it('authenticates live passwords in opaque sessions and applies explicit case grants', async () => {
    const directory = await mkdtemp('/tmp/loan-live-auth-');
    try {
      const usersFile = `${directory}/reviewers.json`;
      const salt = 'a'.repeat(32);
      const password = 'synthetic-test-password';
      await writeFile(usersFile, JSON.stringify([{ id: 'live-reviewer', displayName: 'Local reviewer', role: 'reviewer', applicationIds: ['*'], salt, passwordHash: await createPasswordHash(password, salt) }]), { mode: 0o600 });
      const h = await harness();
      const authentication = await passwordSessions(usersFile, h.database);
      const live = await createApi({
        config: readApiConfig({ MODE: 'live' }), database: h.database,
        artifacts: { putImmutable: vi.fn(), putJsonImmutable: vi.fn(), getBytes: vi.fn(), getJson: vi.fn() },
        workflows: { startApplication: h.startApplication, submitReview: h.submitReview },
        authenticate: authentication.authenticate, login: authentication.login, logout: authentication.delete,
      });
      apps.push(live);
      await live.ready();
      expect((await live.inject({ method: 'POST', url: '/api/session', payload: { reviewerId: 'demo-supervisor' } })).statusCode).toBe(401);
      expect((await live.inject({ method: 'POST', url: '/api/session', payload: { reviewerId: 'live-reviewer', password: 'wrong' } })).statusCode).toBe(401);
      const signedIn = await live.inject({ method: 'POST', url: '/api/session', payload: { reviewerId: 'live-reviewer', password } });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json()).toEqual({ identity: { id: 'live-reviewer', displayName: 'Local reviewer', role: 'reviewer', applicationIds: ['*'] } });
      const sessionCookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
      expect(sessionCookie).not.toContain(password);
      expect((await live.inject({ url: '/api/session', headers: { cookie: sessionCookie } })).statusCode).toBe(200);
      expect((await live.inject({ method: 'DELETE', url: '/api/session', headers: { cookie: sessionCookie } })).statusCode).toBe(204);
      expect((await live.inject({ url: '/api/session', headers: { cookie: sessionCookie } })).statusCode).toBe(401);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses canonical environment variable names for the actual API mode and limits', () => {
    expect(readApiConfig({ MODE: 'live', APP_MODE: 'fixture', COMPANY_NAME: 'Fictional Motors', HOST: '0.0.0.0', PORT: '4321', MAX_ACTIVE_APPLICATIONS: '80' })).toMatchObject({ mode: 'live', brandName: 'Fictional Motors', host: '0.0.0.0', port: 4321, admissionLimit: 80 });
  });

  it('queries uncommitted progress without showing a final outcome before audit confirmation', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const uploaded = await upload(h.app, cookie);
    const application = h.applications.get(uploaded.json<{ applicationId: string }>().applicationId)!;
    const queryApplicationState = vi.fn(async (): Promise<ApplicationState> => ({
      applicationId: application.id, workflowId: application.workflowId, workflowRunId: application.workflowRunId!,
      status: 'AUDIT_PENDING', stage: 'final audit', caseRevision: 0, evidenceRevision: 1,
      policyVersion: application.policyVersion, overdue: false,
    }));
    const queried = await createApi({
      config: readApiConfig({ MODE: 'fixture' }), database: h.database,
      artifacts: { putImmutable: vi.fn(), putJsonImmutable: vi.fn(), getBytes: vi.fn(), getJson: vi.fn() },
      workflows: { startApplication: h.startApplication, submitReview: h.submitReview, queryApplicationState },
    });
    apps.push(queried);
    const current = await queried.inject({ url: `/api/applications/${application.id}`, headers: { cookie } });
    expect(current.json()).toMatchObject({ application: { status: 'UPLOADED' }, workflowState: { status: 'AUDIT_PENDING', stage: 'final audit' } });
    expect(queryApplicationState).toHaveBeenCalledWith(application.workflowId, application.workflowRunId);
    queryApplicationState.mockResolvedValueOnce({ ...(await queryApplicationState()), status: 'PASS' });
    const racingCommit = await queried.inject({ url: `/api/applications/${application.id}`, headers: { cookie } });
    expect(racingCommit.json()).toMatchObject({ workflowState: { status: 'AUDIT_PENDING' } });
    application.auditCommitted = true;
    application.status = 'PASS';
    const calls = queryApplicationState.mock.calls.length;
    const committed = await queried.inject({ url: `/api/applications/${application.id}`, headers: { cookie } });
    expect(committed.json()).toMatchObject({ application: { status: 'PASS', auditCommitted: true }, workflowState: null });
    expect(queryApplicationState.mock.calls).toHaveLength(calls);
  });
});
