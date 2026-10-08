import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { artifactRefSchema, ocrManifestSchema, rawExtractionSchema, policySnapshotSchema, type ArtifactRef, type OcrManifest } from '../contracts.js';
import { DEMO_POLICY, canonicalJson } from '../policy.js';
import type { ApplicationProjection, ReviewCase, CreateApplicationInput, ApplicationPatch, CommandAuditInput, CommandAudit, FinalCommitInput, AuditEventInput } from '../storage.js';
import type { ApplicationInput, ApplicationState, ReviewCommand, ReviewAcceptance } from '../workflows/application-contract.js';
import { reviewContentSchema } from '../workflows/application-contract.js';
import { canAccessApplication, fixtureReviewers, fixtureSessions, isSameOrigin, type AuthenticateReviewer, type ReviewerIdentity, type SessionStore } from './auth.js';
import type { ApiConfig } from './config.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type ApplicationView = ApplicationProjection;
export type ReviewCaseView = ReviewCase;

export interface ApiDatabase extends SessionStore {
  createApplication(input: CreateApplicationInput): Promise<ApplicationView>;
  getApplication(id: string): Promise<ApplicationView | null>;
  listApplications(limit?: number): Promise<ApplicationView[]>;
  updateApplication(id: string, patch: ApplicationPatch): Promise<unknown>;
  getReviewCase(id: string): Promise<ReviewCaseView | null>;
  listReviewCases(): Promise<ReviewCaseView[]>;
  getAudit(id: string): Promise<unknown>;
  recordCommand(input: CommandAuditInput): Promise<unknown>;
  getCommand(applicationId: string, commandId: string): Promise<CommandAudit | null>;
  recordEvent(input: AuditEventInput): Promise<unknown>;
  commitFinal(input: FinalCommitInput): Promise<ApplicationView>;
}

export interface ApiArtifacts {
  putImmutable(key: string, bytes: Buffer, contentType: string): Promise<ArtifactRef>;
  getBytes(key: string): Promise<Buffer>;
  getJson<T>(key: string): Promise<T>;
  putJsonImmutable(key: string, value: unknown): Promise<ArtifactRef>;
}

export type { ReviewCommand } from '../workflows/application-contract.js';

export class ReviewRejectedError extends Error {}
export class WorkflowStartRejectedError extends Error {}
export class WorkflowStartUnconfirmedError extends Error {}

export interface ApiWorkflowClient {
  startApplication(input: ApplicationInput, workflowId: string): Promise<{ runId: string }>;
  submitReview(command: ReviewCommand): Promise<ReviewAcceptance>;
  queryApplicationState?(workflowId: string, runId?: string | null): Promise<ApplicationState | null>;
}

export interface ApiDependencies {
  config: ApiConfig; database: ApiDatabase; artifacts: ApiArtifacts; workflows: ApiWorkflowClient;
  authenticate?: AuthenticateReviewer;
  login?: (reviewerId: string, password: string) => Promise<{ token: string; identity: ReviewerIdentity } | null>;
  logout?: (token: string | undefined) => Promise<void>;
  /** Only server-owned hashes identify synthetic fixtures; filenames and request JSON never do. */
  knownFixtureHashes?: ReadonlySet<string>;
}

const commandBodySchema = z.object({
  commandId: z.string().uuid(), applicationId: z.string().uuid(),
  workflowId: z.string().min(1).max(200), workflowRunId: z.string().uuid(),
  caseRevision: z.number().int().positive(), evidenceRevision: z.number().int().positive(),
  policyVersion: z.string().min(1).max(100),
  action: z.enum(['CORRECT', 'VERIFY', 'FINALIZE', 'OVERRIDE', 'REQUEST_DOCUMENTS']),
  note: z.string().trim().min(1).max(4000),
  corrections: rawExtractionSchema.optional(), decision: z.enum(['PASS', 'FAIL']).optional(),
}).strict().superRefine((command, context) => {
  if (command.action === 'CORRECT' && !command.corrections) context.addIssue({ code: 'custom', message: 'Cited corrections are required.' });
  if ((command.action === 'FINALIZE' || command.action === 'OVERRIDE') && !command.decision) context.addIssue({ code: 'custom', message: 'A simulated decision is required.' });
  if (command.action !== 'CORRECT' && command.corrections) context.addIssue({ code: 'custom', message: 'Corrections are only allowed for CORRECT.' });
  if (command.action !== 'FINALIZE' && command.action !== 'OVERRIDE' && command.decision) context.addIssue({ code: 'custom', message: 'A decision is only allowed for FINALIZE or OVERRIDE.' });
});

const idParams = z.object({ id: z.string().uuid() });
const terminalStatuses = new Set(['PASS', 'FAIL', 'NEEDS_DOCUMENTS', 'INPUT_ERROR', 'PROCESSING_ERROR', 'CANCELLED']);
const storedStartSchema = z.object({
  applicationId: z.string().uuid(), document: artifactRefSchema, documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['fixture', 'live']), policy: policySnapshotSchema, revision: z.number().int().positive(),
  parentApplicationId: z.string().uuid().optional(),
}).strict();

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionRef(application: ApplicationView, name: string): ArtifactRef | undefined {
  const value = artifactRefSchema.safeParse(application.data[name]);
  return value.success ? value.data : undefined;
}

export async function readFixtureHashes(path: string): Promise<ReadonlySet<string>> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
    const documentHashes = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) for (const child of node) visit(child);
      else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) {
        if ((key === 'documentHash' || key === 'sha256') && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) documentHashes.add(value);
        else if (typeof value === 'object') visit(value);
      }
    };
    visit(manifest);
    return documentHashes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

/** Retry only the stored upload start, with its existing immutable workflow identity. */
export async function resumeApplicationStart(dependencies: ApiDependencies, application: ApplicationView, actorId: string) {
  const { database, workflows } = dependencies;
  const input = storedStartSchema.parse(application.data['startRequest']);
  if (input.applicationId !== application.id || input.documentHash !== application.documentHash
      || input.document.key !== application.documentKey || input.document.sha256 !== application.documentHash
      || input.policy.version !== application.policyVersion || input.policy.hash !== application.policyHash) {
    throw new Error('Stored workflow start binding is inconsistent.');
  }
  let execution: Awaited<ReturnType<ApiWorkflowClient['startApplication']>>;
  try { execution = await workflows.startApplication(input, application.workflowId); }
  catch (error) {
    if (error instanceof WorkflowStartRejectedError) {
      await database.commitFinal({ applicationId: application.id, eventId: `${application.id}:workflow-start-failed`,
        status: 'PROCESSING_ERROR', actorType: 'api', actorId, decisionAuthority: 'technical-error',
        payload: { stage: 'start', code: 'WORKFLOW_START_REJECTED', educationalSimulation: true } });
      return { statusCode: 503, body: { code: 'WORKFLOW_START_REJECTED', applicationId: application.id, message: 'Temporal rejected the workflow start. Fix local authentication or configuration, then submit a linked retry.' } };
    }
    const observed = await database.getApplication(application.id);
    if (observed?.workflowRunId) return { statusCode: 202, body: { applicationId: application.id, workflowId: application.workflowId, status: observed.status, educationalSimulation: true } };
    await database.updateApplication(application.id, { stage: 'START_PENDING' });
    await database.recordEvent({ applicationId: application.id, eventId: `${application.id}:workflow-start-unconfirmed`,
      type: 'START_UNCONFIRMED', actorType: 'api', payload: { workflowId: application.workflowId, code: 'START_ACKNOWLEDGEMENT_UNCONFIRMED' } });
    return { statusCode: 202, body: { applicationId: application.id, workflowId: application.workflowId, status: 'UPLOADED', stage: 'START_PENDING', startUnconfirmed: true, educationalSimulation: true } };
  }
  let projectionPending = false;
  try { await database.updateApplication(application.id, { workflowRunId: execution.runId }); }
  catch { projectionPending = true; } // The native parent durably retries this same identity projection.
  return { statusCode: 202, body: { applicationId: application.id, workflowId: application.workflowId, status: 'UPLOADED', ...(projectionPending ? { projectionPending: true } : {}), educationalSimulation: true } };
}

/** One startup pass resumes durable pending starts; it is not a background scheduler. */
export async function reconcilePendingStarts(dependencies: ApiDependencies): Promise<void> {
  const pending = (await dependencies.database.listApplications(500)).filter((application) => application.stage === 'START_PENDING' && !application.auditCommitted);
  for (const application of pending) await resumeApplicationStart(dependencies, application, 'startup-recovery');
}

export async function createApi(dependencies: ApiDependencies) {
  const { config, database, artifacts, workflows } = dependencies;
  if (config.mode === 'live' && !dependencies.authenticate) {
    throw new Error('Live mode requires a real server-side authenticator with case authorization. The local fixture identity selector is disabled.');
  }
  const app = Fastify({ bodyLimit: MAX_UPLOAD_BYTES + 64 * 1024, logger: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 }, throwFileSizeLimit: true });
  const sessions = fixtureSessions(database);
  const authenticate = dependencies.authenticate ?? sessions.authenticate;
  const loginAttempts = new Map<string, { count: number; until: number }>();

  app.addHook('onRequest', async (request, reply) => {
    if (config.mode === 'fixture') {
      let hostname = '';
      try { hostname = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch { /* Reject invalid hosts below. */ }
      const publicHostname = config.publicOrigin ? new URL(config.publicOrigin).hostname : undefined;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) && hostname !== publicHostname) {
        return reply.code(403).send({ code: 'LOCAL_HOST_REQUIRED', message: 'Fixture mode is restricted to local development hosts.' });
      }
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && !isSameOrigin(request, config.publicOrigin)) {
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: 'Use the application origin for commands.' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const details = error && typeof error === 'object' ? error as { code?: unknown; statusCode?: unknown } : {};
    const code = typeof details.code === 'string' ? details.code : '';
    if (code.includes('FILE_TOO_LARGE') || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ code: 'UPLOAD_TOO_LARGE', message: 'Upload a PDF no larger than 20 MiB.', action: 'RESUBMIT' });
    }
    if (code.includes('FILES_LIMIT') || code.includes('PARTS_LIMIT') || code.includes('FIELDS_LIMIT')) {
      return reply.code(400).send({ code: 'UPLOAD_INVALID', message: 'Upload one PDF packet.', action: 'RESUBMIT' });
    }
    if (code === 'APPLICATION_LIMIT') return reply.code(429).send({ code, message: 'The local processing admission limit has been reached. Try again when a case completes.' });
    if (code === 'COMMAND_CONFLICT') return reply.code(409).send({ code, message: 'This command ID already belongs to a different request. Reload the case before submitting a new command.' });
    const status = typeof details.statusCode === 'number' && details.statusCode >= 400 && details.statusCode < 500 ? details.statusCode : 503;
    return reply.code(status).send({ code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_INVALID', message: status === 503 ? 'A required local service is unavailable. Retry after it recovers.' : 'Check the submitted request.' });
  });

  async function requireReviewer(request: FastifyRequest, reply: FastifyReply) {
    const identity = await authenticate(request);
    if (!identity) reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'Sign in as an authorized reviewer to continue.' });
    return identity;
  }

  async function authorizedApplication(request: FastifyRequest, reply: FastifyReply) {
    const identity = await requireReviewer(request, reply);
    if (!identity) return null;
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ code: 'INVALID_ID' });
      return null;
    }
    const application = await database.getApplication(params.data.id);
    if (!application || !canAccessApplication(identity, params.data.id, config.mode)) {
      reply.code(404).send({ code: 'APPLICATION_NOT_FOUND' });
      return null;
    }
    return { identity, application };
  }

  app.get('/api/health', async () => ({ status: 'ok', mode: config.mode }));
  app.get('/api/config', async () => ({
    brandName: config.brandName, accentColor: config.accentColor, mode: config.mode,
    educationalSimulation: true, maxUploadBytes: MAX_UPLOAD_BYTES,
    authentication: config.mode === 'fixture' ? 'fixture-selector' : 'password',
    reviewers: config.mode === 'fixture' ? fixtureReviewers : [],
  }));

  app.post('/api/session', async (request, reply) => {
    if (config.mode === 'live') {
      if (!dependencies.login) return reply.code(404).send({ code: 'LOCAL_IDENTITY_DISABLED' });
      const ip = request.ip;
      const now = Date.now();
      for (const [address, state] of loginAttempts) if (state.until <= now) loginAttempts.delete(address);
      const attempts = loginAttempts.get(ip) ?? { count: 0, until: now + 60_000 };
      attempts.count += 1;
      loginAttempts.set(ip, attempts);
      if (attempts.count > 10) return reply.code(429).send({ code: 'LOGIN_RATE_LIMITED', message: 'Wait one minute before trying again.' });
      const body = z.object({ reviewerId: z.string().min(1).max(64), password: z.string().min(1).max(1024) }).strict().safeParse(request.body);
      const session = body.success ? await dependencies.login(body.data.reviewerId, body.data.password) : null;
      if (!session) return reply.code(401).send({ code: 'LOGIN_INVALID', message: 'Invalid reviewer credentials.' });
      reply.setCookie('loan-review-session', session.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https', maxAge: 8 * 60 * 60 });
      return { identity: session.identity };
    }
    const body = z.object({ reviewerId: z.string() }).strict().safeParse(request.body);
    const token = body.success ? await sessions.create(body.data.reviewerId) : null;
    if (!token) return reply.code(400).send({ code: 'REVIEWER_INVALID' });
    reply.setCookie('loan-review-session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https', maxAge: 8 * 60 * 60 });
    return { identity: fixtureReviewers.find((reviewer) => reviewer.id === body.data!.reviewerId) };
  });
  app.get('/api/session', async (request, reply) => {
    const identity = await requireReviewer(request, reply);
    if (identity) return { identity };
  });
  app.delete('/api/session', async (request, reply) => {
    await sessions.delete(request.cookies['loan-review-session']);
    await dependencies.logout?.(request.cookies['loan-review-session']);
    reply.clearCookie('loan-review-session', { path: '/' });
    return reply.code(204).send();
  });

  app.post('/api/applications', async (request, reply) => {
    const identity = await requireReviewer(request, reply);
    if (!identity) return;
    if (config.mode === 'live' && !identity.applicationIds?.includes('*')) return reply.code(403).send({ code: 'UPLOAD_ROLE_REQUIRED', message: 'Application upload requires the server-configured all-applications grant.' });
    // This is staging and starting only. PDF rendering, OCR and inference run in workers.
    const active = (await database.listApplications(config.admissionLimit + 1)).filter((application) => !terminalStatuses.has(application.status));
    if (active.length >= config.admissionLimit) return reply.code(429).send({ code: 'APPLICATION_LIMIT', message: 'Processing capacity is full. Try again after a case completes.' });
    let bytes: Buffer | undefined;
    let rawParent: unknown;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (bytes) return reply.code(400).send({ code: 'ONE_PDF_REQUIRED', action: 'RESUBMIT' });
        bytes = await part.toBuffer();
        if (part.file.truncated || bytes.byteLength > MAX_UPLOAD_BYTES) return reply.code(413).send({ code: 'UPLOAD_TOO_LARGE', action: 'RESUBMIT' });
      } else if (part.fieldname === 'parentApplicationId') rawParent = part.value;
      else return reply.code(400).send({ code: 'UPLOAD_FIELD_INVALID', message: 'Only a PDF and an optional linked parent application are accepted.' });
    }
    if (!bytes) return reply.code(400).send({ code: 'PDF_REQUIRED', action: 'RESUBMIT' });
    if (bytes.byteLength < 8 || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      return reply.code(400).send({ code: 'INPUT_ERROR', message: 'The packet must be a PDF. Its filename is not used for format validation.', action: 'RESUBMIT' });
    }
    const parentId = rawParent ? z.string().uuid().safeParse(rawParent) : null;
    if (parentId && !parentId.success) return reply.code(400).send({ code: 'PARENT_INVALID' });
    let parent: ApplicationView | null = null;
    if (parentId?.success) {
      parent = await database.getApplication(parentId.data);
      if (!parent || !canAccessApplication(identity, parent.id, config.mode)) return reply.code(404).send({ code: 'APPLICATION_NOT_FOUND' });
      if (!['NEEDS_DOCUMENTS', 'INPUT_ERROR', 'PROCESSING_ERROR'].includes(parent.status)) return reply.code(409).send({ code: 'REPLACEMENT_NOT_ALLOWED', message: 'Replacement packets require a completed resubmission or processing-error attempt.' });
    }
    const documentHash = hash(bytes);
    const document = await artifacts.putImmutable(`documents/${documentHash}.pdf`, bytes, 'application/pdf');
    const applicationId = randomUUID();
    const workflowId = `loan-${applicationId}`;
    const revision = parent ? parent.revision + 1 : 1;
    const startRequest: ApplicationInput = {
      applicationId, document, documentHash, mode: config.mode, policy: DEMO_POLICY, revision,
      ...(parent ? { parentApplicationId: parent.id } : {}),
    };
    const application = await database.createApplication({
      id: applicationId, documentKey: document.key, documentHash, mode: config.mode,
      workflowId, policyVersion: DEMO_POLICY.version, policyHash: DEMO_POLICY.hash, revision,
      ...(parent ? { parentApplicationId: parent.id } : {}), admissionLimit: config.admissionLimit,
      data: { educationalSimulation: true, sourceVerifiedFixture: config.mode === 'fixture' && Boolean(dependencies.knownFixtureHashes?.has(documentHash)), uploadedBy: identity.id, startRequest },
    });
    const started = await resumeApplicationStart(dependencies, application, identity.id);
    return reply.code(started.statusCode).send(started.body);
  });

  app.post('/api/applications/:id/resume', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    if (authorized.application.auditCommitted || authorized.application.stage !== 'START_PENDING') return reply.code(409).send({ code: 'START_NOT_PENDING' });
    const started = await resumeApplicationStart(dependencies, authorized.application, authorized.identity.id);
    return reply.code(started.statusCode).send(started.body);
  });

  app.get('/api/applications', async (request, reply) => {
    const identity = await requireReviewer(request, reply);
    if (!identity) return;
    return { applications: (await database.listApplications()).filter((application) => canAccessApplication(identity, application.id, config.mode)) };
  });
  app.get('/api/applications/:id', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const { application } = authorized;
    let workflowState: ApplicationState | null = null;
    if (!application.auditCommitted && workflows.queryApplicationState) {
      try { workflowState = await workflows.queryApplicationState(application.workflowId, application.workflowRunId); }
      catch { /* A closed or unavailable workflow leaves the durable projection usable. */ }
      if (workflowState?.applicationId !== application.id) workflowState = null;
      if (workflowState && terminalStatuses.has(workflowState.status)) {
        // The final outcome is shown only after its committed projection is read.
        workflowState = { ...workflowState, status: 'AUDIT_PENDING', stage: 'Confirming final audit projection' };
      }
    }
    return { application, workflowState };
  });
  app.get('/api/applications/:id/audit', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const audit = await database.getAudit(authorized.application.id);
    const query = z.object({ download: z.string().optional() }).safeParse(request.query);
    if (query.success && query.data.download === '1') reply.header('Content-Disposition', `attachment; filename="application-${authorized.application.id}-audit.json"`);
    return audit;
  });

  app.get('/api/reviews', async (request, reply) => {
    const identity = await requireReviewer(request, reply);
    if (!identity) return;
    return { cases: (await database.listReviewCases()).filter((reviewCase) => canAccessApplication(identity, reviewCase.applicationId, config.mode)) };
  });
  app.get('/api/reviews/:id', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const reviewCase = await database.getReviewCase(authorized.application.id);
    if (!reviewCase) return reply.code(404).send({ code: 'REVIEW_NOT_FOUND' });
    return { application: authorized.application, reviewCase };
  });

  app.post('/api/reviews/:id/commands', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const { identity, application } = authorized;
    const parsed = commandBodySchema.safeParse(request.body);
    const raw = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const commandId = typeof raw['commandId'] === 'string' && z.string().uuid().safeParse(raw['commandId']).success ? raw['commandId'] : randomUUID();
    const requestHash = hash(canonicalJson({ body: request.body ?? null, actorId: identity.id, actorRole: identity.role }));
    async function reject(statusCode: number, code: string, message: string) {
      await database.recordEvent({ applicationId: application.id, eventId: `${application.id}:api-command-rejected:${commandId}:${requestHash}`,
        type: 'REVIEW_COMMAND_REJECTED', actorType: 'reviewer', actorId: identity.id,
        payload: { commandId, requestHash, code, statusCode } });
      await database.recordCommand({ applicationId: application.id, commandId, reviewerId: identity.id, status: 'rejected', requestHash, payload: { action: raw['action'], note: typeof raw['note'] === 'string' ? raw['note'] : undefined }, result: { code, message }, statusCode });
      return reply.code(statusCode).send({ accepted: false, commandId, code, message });
    }
    if (!parsed.success) return reject(400, 'COMMAND_INVALID', 'Commands require the current workflow, case, evidence and policy binding, a unique UUID and a note. Identity fields are derived from the session.');
    const body = parsed.data;
    const previous = await database.getCommand(application.id, commandId);
    if (previous) {
      if (previous.requestHash !== requestHash || previous.reviewerId !== identity.id) {
        await database.recordEvent({ applicationId: application.id, eventId: `${application.id}:api-command-conflict:${commandId}:${requestHash}`,
          type: 'REVIEW_COMMAND_REJECTED', actorType: 'reviewer', actorId: identity.id,
          payload: { commandId, code: 'COMMAND_CONFLICT', requestHash } });
        return reply.code(409).send({ accepted: false, commandId, code: 'COMMAND_CONFLICT', message: 'This command ID was already used with different content or identity.' });
      }
      return reply.code(previous.statusCode).send({ ...previous.result, educationalSimulation: true });
    }
    if (body.applicationId !== application.id || body.workflowId !== application.workflowId || body.workflowRunId !== application.workflowRunId || body.policyVersion !== application.policyVersion) {
      return reject(409, 'STALE_BINDING', 'Reload this case before submitting; its workflow or policy binding changed.');
    }
    if (body.action === 'OVERRIDE' && identity.role !== 'override-reviewer') return reject(403, 'OVERRIDE_ROLE_REQUIRED', 'Select an override-capable reviewer for an explicit educational override.');
    // Claim this command ID before staging so a lost acknowledgement cannot let
    // different content reuse Temporal's cached Update result.
    const claimKey = `reviews/${application.id}/${commandId}/request.json`;
    try { await artifacts.putJsonImmutable(claimKey, { requestHash }); }
    catch {
      try {
        const claim = await artifacts.getJson<{ requestHash: string }>(claimKey);
        if (claim.requestHash !== requestHash) {
          await database.recordEvent({ applicationId: application.id, eventId: `${application.id}:api-command-conflict:${commandId}:${requestHash}`,
            type: 'REVIEW_COMMAND_REJECTED', actorType: 'reviewer', actorId: identity.id, payload: { commandId, code: 'COMMAND_CONFLICT', requestHash } });
          return reply.code(409).send({ accepted: false, commandId, code: 'COMMAND_CONFLICT', message: 'This command ID was already staged with different content or identity.' });
        }
      } catch { /* Leave the command retryable if storage is unavailable. */ }
      return reply.code(503).send({ accepted: null, commandId, code: 'REVIEW_CONTENT_STAGING_UNAVAILABLE', message: 'Review content could not be staged. Retry the same command ID and content after storage recovers.' });
    }
    const { note, corrections, ...binding } = body;
    const content = reviewContentSchema.parse({ applicationId: application.id, commandId, action: body.action, note, ...(corrections ? { corrections } : {}) });
    let contentRef: ArtifactRef;
    try { contentRef = await artifacts.putJsonImmutable(`reviews/${application.id}/${commandId}/${requestHash}.json`, content); }
    catch { return reply.code(503).send({ accepted: null, commandId, code: 'REVIEW_CONTENT_STAGING_UNAVAILABLE', message: 'Review content could not be staged. Retry the same command ID and content after storage recovers.' }); }
    const command: ReviewCommand = { ...binding, contentRef, actorId: identity.id, actorRole: identity.role };
    let result: Awaited<ReturnType<ApiWorkflowClient['submitReview']>>;
    try {
      result = await workflows.submitReview(command);
    } catch (error) {
      if (error instanceof ReviewRejectedError) return reject(409, 'UPDATE_REJECTED', 'The workflow rejected this command. Reload the case before submitting a new command.');
      await database.recordEvent({ applicationId: application.id, eventId: `${application.id}:api-update-unconfirmed:${commandId}:${requestHash}`,
        type: 'REVIEW_UPDATE_ACKNOWLEDGEMENT_UNCONFIRMED', actorType: 'reviewer', actorId: identity.id,
        payload: { commandId, requestHash, code: 'UPDATE_ACKNOWLEDGEMENT_UNCONFIRMED' } });
      return reply.code(503).send({ accepted: null, commandId, code: 'UPDATE_ACKNOWLEDGEMENT_UNCONFIRMED', status: 'SAVING', message: 'Acceptance could not be confirmed. Retry the same command ID and content after local services recover.' });
    }
    await database.recordCommand({ applicationId: application.id, commandId, reviewerId: identity.id, status: result.accepted ? 'accepted' : 'rejected', requestHash, payload: { ...command }, result: { ...result }, statusCode: result.accepted ? 202 : 409 });
    return reply.code(result.accepted ? 202 : 409).send({ ...result, educationalSimulation: true });
  });

  app.get('/api/applications/:id/document', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const bytes = await artifacts.getBytes(authorized.application.documentKey);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', 'inline; filename="educational-application.pdf"');
    return reply.type('application/pdf').send(bytes);
  });
  app.get('/api/applications/:id/evidence', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const ocrRef = projectionRef(authorized.application, 'ocrManifestRef');
    const extractionRef = projectionRef(authorized.application, 'extractionRef');
    return {
      ocr: ocrRef ? ocrManifestSchema.parse(await artifacts.getJson<OcrManifest>(ocrRef.key)) : null,
      extraction: extractionRef ? await artifacts.getJson(extractionRef.key) : null,
    };
  });
  app.get('/api/applications/:id/pages/:page/image', async (request, reply) => {
    const authorized = await authorizedApplication(request, reply);
    if (!authorized) return;
    const page = z.coerce.number().int().min(1).max(25).safeParse((request.params as { page: string }).page);
    const ocrRef = projectionRef(authorized.application, 'ocrManifestRef');
    if (!page.success || !ocrRef) return reply.code(404).send({ code: 'PAGE_NOT_FOUND' });
    const manifest = ocrManifestSchema.parse(await artifacts.getJson<OcrManifest>(ocrRef.key));
    const image = manifest.pages.find((item) => item.pageNumber === page.data)?.imageRef;
    if (!image) return reply.code(404).send({ code: 'PAGE_NOT_FOUND' });
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type(image.contentType).send(await artifacts.getBytes(image.key));
  });
  return app;
}
