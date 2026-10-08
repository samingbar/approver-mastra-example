import { createHash } from 'node:crypto';
import {
  CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import pg, { type PoolClient } from 'pg';
import type { ArtifactRef } from './contracts.js';
import type { ReviewerIdentity } from './api/auth.js';
export type { ArtifactRef } from './contracts.js';

export interface ArtifactStoreConfig {
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Shared stable-key artifacts. An existing key can only contain the same bytes. */
export class ArtifactStore {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(config: ArtifactStoreConfig = {}) {
    this.bucket = config.bucket ?? process.env.S3_BUCKET ?? 'loan-artifacts';
    this.client = new S3Client({
      endpoint: config.endpoint ?? process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: config.region ?? process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId ?? process.env.S3_ACCESS_KEY ?? process.env.S3_ACCESS_KEY_ID ?? 'S3RVER',
        secretAccessKey: config.secretAccessKey ?? process.env.S3_SECRET_KEY ?? process.env.S3_SECRET_ACCESS_KEY ?? 'S3RVER',
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (createError) {
        if (!hasErrorName(createError, ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'])) throw createError;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    assertArtifactKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    assertArtifactKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`Artifact body missing: ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async getJson<T>(key: string): Promise<T> {
    return JSON.parse((await this.getBytes(key)).toString('utf8')) as T;
  }

  async putImmutable(key: string, bytes: Uint8Array, contentType: string): Promise<ArtifactRef> {
    assertArtifactKey(key);
    const body = Buffer.from(bytes);
    const sha256 = hashBytes(body);
    const ref: ArtifactRef = { key, sha256, contentType, size: body.length };
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
        Metadata: { sha256 }, IfNoneMatch: '*',
      }));
      return ref;
    } catch (error) {
      if (!hasErrorName(error, ['PreconditionFailed', 'ConditionalRequestConflict'])
          && getStatus(error) !== 412 && getStatus(error) !== 409) throw error;
      // Check the actual bytes, not merely a caller-controlled object metadata hash.
      const existing = await this.getBytes(key);
      if (hashBytes(existing) !== sha256) throw new Error(`Immutable artifact conflict: ${key}`);
      return ref;
    }
  }

  async putJsonImmutable(key: string, value: unknown): Promise<ArtifactRef> {
    return this.putImmutable(key, Buffer.from(canonicalJson(value)), 'application/json');
  }

  close(): void { this.client.destroy(); }
}

export type ApplicationMode = 'fixture' | 'live';
export interface ApplicationProjection {
  id: string;
  documentKey: string;
  documentHash: string;
  mode: ApplicationMode;
  revision: number;
  parentApplicationId: string | null;
  workflowId: string;
  workflowRunId: string | null;
  policyVersion: string;
  policyHash: string;
  status: string;
  stage: string;
  evidenceRevision: number;
  auditCommitted: boolean;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApplicationInput {
  id: string;
  documentKey: string;
  documentHash: string;
  mode: ApplicationMode;
  workflowId: string;
  workflowRunId?: string;
  revision?: number;
  parentApplicationId?: string;
  policyVersion: string;
  policyHash: string;
  data?: Record<string, unknown>;
  admissionLimit?: number;
}

export class ApplicationAdmissionError extends Error {
  readonly code = 'APPLICATION_LIMIT';
  constructor() { super('Active application limit reached; try again when processing completes'); }
}
export class CommandConflictError extends Error {
  readonly code = 'COMMAND_CONFLICT';
  readonly statusCode = 409;
  constructor() { super('Review command ID reused with different content'); }
}

export interface ApplicationPatch {
  status?: string;
  stage?: string;
  workflowRunId?: string;
  evidenceRevision?: number;
  data?: Record<string, unknown>;
}

export interface AuditEventInput {
  eventId: string;
  applicationId: string;
  type: string;
  actorType?: string;
  actorId?: string;
  reasonCodes?: string[];
  evidenceRevision?: number;
  evidenceHash?: string;
  artifactRefs?: ArtifactRef[];
  workflowId?: string;
  workflowRunId?: string;
  payload?: Record<string, unknown>;
}

export interface AuditEvent {
  eventId: string;
  applicationId: string;
  applicationRevision: number;
  sequence: number;
  timestamp: string;
  actorType: string;
  actorId: string | null;
  type: string;
  policyVersion: string;
  policyHash: string;
  evidenceRevision: number | null;
  evidenceHash: string | null;
  workflowId: string;
  workflowRunId: string | null;
  reasonCodes: string[];
  artifactRefs: ArtifactRef[];
  payload: Record<string, unknown>;
}

export interface ReviewCase {
  applicationId: string;
  caseRevision: number;
  evidenceRevision: number;
  policyVersion: string;
  workflowId: string;
  workflowRunId: string;
  status: 'OPEN' | 'CLOSED';
  overdue: boolean;
  payload: Record<string, unknown>;
  openedAt: string;
  updatedAt: string;
}

export type OpenReviewCaseInput = Pick<ReviewCase,
  'applicationId' | 'caseRevision' | 'evidenceRevision' | 'policyVersion' | 'workflowId' | 'workflowRunId'>
  & { payload?: Record<string, unknown> };

export interface CommandAuditInput {
  applicationId: string;
  commandId: string;
  reviewerId: string;
  status: 'accepted' | 'rejected';
  requestHash?: string;
  payload?: object;
  result?: Record<string, unknown>;
  statusCode?: number;
}
export interface CommandAudit extends CommandAuditInput {
  statusCode: number;
  createdAt: string;
}

export interface FinalCommitInput extends Omit<AuditEventInput, 'type'> {
  status: 'PASS' | 'FAIL' | 'NEEDS_DOCUMENTS' | 'INPUT_ERROR' | 'PROCESSING_ERROR' | 'CANCELLED';
  originalRecommendation?: unknown;
  finalDecision?: unknown;
  decisionAuthority?: string;
}

export interface ApplicationAudit {
  application: ApplicationProjection;
  reviewCase: ReviewCase | null;
  events: AuditEvent[];
  commands: CommandAudit[];
}

/** Runtime app role performs DML only. Schema setup uses db/bootstrap.ts. */
export class PgStore {
  readonly pool: pg.Pool;

  constructor(config: { connectionString?: string; pool?: pg.Pool } | string = {}) {
    const options = typeof config === 'string' ? { connectionString: config } : config;
    this.pool = options.pool ?? new pg.Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL
        ?? 'postgresql://loan_app:loan_demo@127.0.0.1:5432/loan_demo',
      max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    });
  }

  async ping(): Promise<void> { await this.pool.query('SELECT 1'); }
  async close(): Promise<void> { await this.pool.end(); }

  async putReviewerSession(input: { tokenHash: string; identity: ReviewerIdentity; expiresAt: string }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash) || !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new Error('Reviewer session requires a token hash and valid expiration');
    }
    await this.transaction(async (client) => {
      await client.query('DELETE FROM reviewer_sessions WHERE expires_at <= now()');
      await client.query(`INSERT INTO reviewer_sessions (token_hash,identity,expires_at) VALUES ($1,$2,$3)
        ON CONFLICT (token_hash) DO NOTHING`, [input.tokenHash, input.identity, input.expiresAt]);
    });
  }

  async getReviewerSession(tokenHash: string): Promise<{ identity: ReviewerIdentity; expiresAt: string } | null> {
    const { rows } = await this.pool.query(`SELECT identity,expires_at FROM reviewer_sessions
      WHERE token_hash = $1 AND expires_at > now()`, [tokenHash]);
    return rows[0] ? { identity: rows[0].identity as ReviewerIdentity, expiresAt: iso(rows[0].expires_at) } : null;
  }

  async deleteReviewerSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM reviewer_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async createApplication(input: CreateApplicationInput): Promise<ApplicationProjection> {
    return this.transaction(async (client) => {
      // One shared PostgreSQL lock enforces admission across every API replica.
      if (input.admissionLimit !== undefined) {
        if (!Number.isInteger(input.admissionLimit) || input.admissionLimit < 1) {
          throw new Error('Admission limit must be a positive integer');
        }
        await client.query('SELECT pg_advisory_xact_lock(7102026)');
        const existing = await client.query('SELECT * FROM applications WHERE id = $1', [input.id]);
        if (!existing.rows[0]) {
          const count = await client.query('SELECT count(*)::integer AS active FROM applications WHERE audit_committed = false');
          if (count.rows[0].active >= input.admissionLimit) throw new ApplicationAdmissionError();
        }
      }
      const { rows } = await client.query(
        `INSERT INTO applications
         (id, document_key, document_hash, mode, revision, parent_application_id, workflow_id,
          workflow_run_id, policy_version, policy_hash, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [input.id, input.documentKey, input.documentHash, input.mode, input.revision ?? 1,
          input.parentApplicationId ?? null, input.workflowId, input.workflowRunId ?? null,
          input.policyVersion, input.policyHash, input.data ?? {}],
      );
      if (rows[0]) {
        const app = applicationRow(rows[0]);
        await insertEvent(client, app, {
          applicationId: app.id, eventId: `${app.id}:upload`, type: 'UPLOADED', actorType: 'api',
          ...(typeof input.data?.uploadedBy === 'string' ? { actorId: input.data.uploadedBy } : {}),
          payload: { documentKey: app.documentKey, documentHash: app.documentHash, mode: app.mode, educationalSimulation: true },
        });
        return app;
      }
      const prior = await client.query('SELECT * FROM applications WHERE id = $1', [input.id]);
      const existing = prior.rows[0] ? applicationRow(prior.rows[0]) : null;
      if (!existing || existing.documentHash !== input.documentHash || existing.documentKey !== input.documentKey
          || existing.workflowId !== input.workflowId || existing.policyVersion !== input.policyVersion
          || existing.policyHash !== input.policyHash || existing.mode !== input.mode
          || existing.revision !== (input.revision ?? 1)
          || existing.parentApplicationId !== (input.parentApplicationId ?? null)) {
        throw new Error(`Application ID conflict: ${input.id}`);
      }
      return existing;
    });
  }

  async getApplication(id: string): Promise<ApplicationProjection | null> {
    const { rows } = await this.pool.query('SELECT * FROM applications WHERE id = $1', [id]);
    return rows[0] ? applicationRow(rows[0]) : null;
  }

  async listApplications(limit = 100): Promise<ApplicationProjection[]> {
    const { rows } = await this.pool.query('SELECT * FROM applications ORDER BY created_at DESC LIMIT $1',
      [Math.min(Math.max(limit, 1), 500)]);
    return rows.map(applicationRow);
  }

  async updateApplication(id: string, patch: ApplicationPatch): Promise<ApplicationProjection> {
    if (patch.status && ['PASS', 'FAIL', 'NEEDS_DOCUMENTS', 'INPUT_ERROR', 'PROCESSING_ERROR', 'CANCELLED'].includes(patch.status)) {
      throw new Error('Final statuses require atomic audit persistence through commitFinal');
    }
    const { rows } = await this.pool.query(
      `UPDATE applications SET status = COALESCE($2,status), stage = COALESCE($3,stage),
       workflow_run_id = COALESCE($4,workflow_run_id), evidence_revision = COALESCE($5,evidence_revision),
       data = data || $6::jsonb, updated_at = now() WHERE id = $1 AND audit_committed = false RETURNING *`,
      [id, patch.status ?? null, patch.stage ?? null, patch.workflowRunId ?? null,
        patch.evidenceRevision ?? null, patch.data ?? {}],
    );
    if (rows[0]) return applicationRow(rows[0]);
    const current = await this.getApplication(id);
    if (current?.auditCommitted) return current;
    throw new Error(`Application missing: ${id}`);
  }

  async recordEvent(input: AuditEventInput): Promise<AuditEvent> {
    return this.transaction(async (client) => {
      const app = await lockApplication(client, input.applicationId);
      return insertEvent(client, app, input);
    });
  }

  async openReviewCase(input: OpenReviewCaseInput): Promise<ReviewCase> {
    return this.transaction(async (client) => {
      const app = await lockApplication(client, input.applicationId);
      if (app.auditCommitted) throw new Error('Cannot reopen a completed application');
      if (input.policyVersion !== app.policyVersion || input.workflowId !== app.workflowId
          || (app.workflowRunId !== null && input.workflowRunId !== app.workflowRunId)) {
        throw new Error('Review case workflow or policy binding conflict');
      }
      const { rows } = await client.query(
        `INSERT INTO review_cases (application_id, case_revision, evidence_revision, policy_version,
         workflow_id, workflow_run_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (application_id) DO UPDATE SET case_revision = EXCLUDED.case_revision,
         evidence_revision = EXCLUDED.evidence_revision, payload = EXCLUDED.payload,
         updated_at = now() WHERE review_cases.case_revision <= EXCLUDED.case_revision
         AND review_cases.status = 'OPEN' RETURNING *`,
        [input.applicationId, input.caseRevision, input.evidenceRevision, input.policyVersion,
          input.workflowId, input.workflowRunId, input.payload ?? {}],
      );
      if (!rows[0]) throw new Error('Review case revision conflict');
      await client.query(`UPDATE applications SET status = 'REVIEW', stage = 'HUMAN_REVIEW',
        evidence_revision = $2, updated_at = now() WHERE id = $1`,
      [input.applicationId, input.evidenceRevision]);
      await insertEvent(client, app, {
        applicationId: input.applicationId, eventId: `${input.applicationId}:case:${input.caseRevision}`,
        type: input.caseRevision === 1 ? 'REVIEW_OPENED' : 'REVIEW_CASE_UPDATED',
        evidenceRevision: input.evidenceRevision, workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        payload: { caseRevision: input.caseRevision, ...input.payload },
      });
      return reviewRow(rows[0]);
    });
  }

  async getReviewCase(applicationId: string): Promise<ReviewCase | null> {
    const { rows } = await this.pool.query('SELECT * FROM review_cases WHERE application_id = $1', [applicationId]);
    return rows[0] ? reviewRow(rows[0]) : null;
  }

  async listReviewCases(): Promise<ReviewCase[]> {
    const { rows } = await this.pool.query(`SELECT * FROM review_cases WHERE status = 'OPEN' ORDER BY opened_at`);
    return rows.map(reviewRow);
  }

  async markReviewOverdue(applicationId: string, eventId: string): Promise<void> {
    await this.transaction(async (client) => {
      const app = await lockApplication(client, applicationId);
      await client.query(`UPDATE review_cases SET overdue = true, updated_at = now()
        WHERE application_id = $1 AND status = 'OPEN'`, [applicationId]);
      await insertEvent(client, app, { applicationId, eventId, type: 'REVIEW_OVERDUE' });
    });
  }

  async recordCommand(input: CommandAuditInput): Promise<CommandAudit> {
    const { rows } = await this.pool.query(
      `INSERT INTO command_audit (application_id,command_id,reviewer_id,status,status_code,request_hash,payload,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (application_id,command_id) DO NOTHING RETURNING *`,
      [input.applicationId, input.commandId, input.reviewerId, input.status,
        input.statusCode ?? (input.status === 'accepted' ? 202 : 409), input.requestHash ?? null,
        input.payload ?? {}, input.result ?? {}],
    );
    if (rows[0]) return commandRow(rows[0]);
    const prior = await this.getCommand(input.applicationId, input.commandId);
    if (!prior || prior.reviewerId !== input.reviewerId
        || (input.requestHash && prior.requestHash && input.requestHash !== prior.requestHash)) {
      throw new CommandConflictError();
    }
    return prior;
  }

  async getCommand(applicationId: string, commandId: string): Promise<CommandAudit | null> {
    const { rows } = await this.pool.query(`SELECT * FROM command_audit WHERE application_id = $1 AND command_id = $2`,
      [applicationId, commandId]);
    return rows[0] ? commandRow(rows[0]) : null;
  }

  /** Commit the final event and projection together. Retried acknowledgement loss is harmless. */
  async commitFinal(input: FinalCommitInput): Promise<ApplicationProjection> {
    return this.transaction(async (client) => {
      const app = await lockApplication(client, input.applicationId);
      const eventInput: AuditEventInput = {
        ...input, type: 'FINAL_COMMITTED', payload: {
          ...input.payload, educationalSimulation: true, mode: app.mode,
          originalRecommendation: input.originalRecommendation,
          finalDecision: input.finalDecision ?? input.status,
          decisionAuthority: input.decisionAuthority ?? 'DEMO_POLICY',
          status: input.status,
        },
      };
      if (app.auditCommitted) {
        // Cancellation can race an already committed final write whose activity
        // acknowledgement was lost. Preserve that committed decision and let the
        // native workflow close with its actual persisted status.
        if (input.status === 'CANCELLED') {
          if (app.status !== 'CANCELLED') {
            const eventId = `${app.id}:late-cancellation`;
            const prior = await client.query('SELECT event_id FROM audit_events WHERE event_id = $1', [eventId]);
            if (!prior.rows[0]) await insertEvent(client, app, {
              applicationId: app.id, eventId, type: 'LATE_CANCELLATION',
              actorType: input.actorType ?? 'operator', actorId: input.actorId,
              evidenceRevision: app.evidenceRevision,
              payload: { requestedStatus: 'CANCELLED', retainedStatus: app.status, code: 'COMMITTED_OUTCOME_RETAINED' },
            });
          }
          return app;
        }
        const { rows } = await client.query('SELECT * FROM audit_events WHERE event_id = $1', [input.eventId]);
        if (!rows[0]) throw new Error('Application already finalized by a different event');
        // Stable events cannot be reused to change any final decision or explanation.
        await insertEvent(client, app, eventInput);
        return app;
      }
      await insertEvent(client, app, eventInput);
      const { rows } = await client.query(`UPDATE applications SET status = $2, stage = 'COMPLETE',
        audit_committed = true, evidence_revision = COALESCE($3,evidence_revision),
        data = data || $4::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [input.applicationId, input.status, input.evidenceRevision ?? null, eventInput.payload]);
      await client.query(`UPDATE review_cases SET status = 'CLOSED', updated_at = now() WHERE application_id = $1`,
        [input.applicationId]);
      return applicationRow(rows[0]);
    });
  }

  async getAudit(applicationId: string): Promise<ApplicationAudit | null> {
    // A single repeatable-read snapshot keeps export and timeline mutually consistent.
    return this.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const appResult = await client.query('SELECT * FROM applications WHERE id = $1', [applicationId]);
      if (!appResult.rows[0]) return null;
      const events = await client.query('SELECT * FROM audit_events WHERE application_id = $1 ORDER BY sequence', [applicationId]);
      const commands = await client.query('SELECT * FROM command_audit WHERE application_id = $1 ORDER BY created_at', [applicationId]);
      const review = await client.query('SELECT * FROM review_cases WHERE application_id = $1', [applicationId]);
      return {
        application: applicationRow(appResult.rows[0]), reviewCase: review.rows[0] ? reviewRow(review.rows[0]) : null,
        events: events.rows.map(eventRow), commands: commands.rows.map(commandRow),
      };
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockApplication(client: PoolClient, id: string): Promise<ApplicationProjection> {
  const { rows } = await client.query('SELECT * FROM applications WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new Error(`Application missing: ${id}`);
  return applicationRow(rows[0]);
}

async function insertEvent(client: PoolClient, app: ApplicationProjection, input: AuditEventInput): Promise<AuditEvent> {
  const content = {
    applicationId: input.applicationId, applicationRevision: app.revision, type: input.type,
    actorType: input.actorType ?? 'SYSTEM', actorId: input.actorId ?? null,
    policyVersion: app.policyVersion, policyHash: app.policyHash,
    evidenceRevision: input.evidenceRevision ?? null, evidenceHash: input.evidenceHash ?? null,
    workflowId: input.workflowId ?? app.workflowId, workflowRunId: input.workflowRunId ?? app.workflowRunId,
    reasonCodes: input.reasonCodes ?? [], artifactRefs: input.artifactRefs ?? [], payload: input.payload ?? {},
  };
  const contentHash = hashBytes(Buffer.from(canonicalJson(content)));
  const existing = await client.query('SELECT * FROM audit_events WHERE event_id = $1', [input.eventId]);
  if (existing.rows[0]) {
    if (existing.rows[0].content_hash !== contentHash) throw new Error(`Audit event ID conflict: ${input.eventId}`);
    return eventRow(existing.rows[0]);
  }
  // Every caller holds the application row lock, making its sequence allocation serial.
  const { rows } = await client.query(
    `INSERT INTO audit_events (event_id,application_id,application_revision,sequence,actor_type,actor_id,
     event_type,policy_version,policy_hash,evidence_revision,evidence_hash,workflow_id,workflow_run_id,
     reason_codes,artifact_refs,payload,content_hash)
     SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
     FROM audit_events WHERE application_id = $2 RETURNING *`,
    [input.eventId, app.id, app.revision, content.actorType, content.actorId, input.type,
      app.policyVersion, app.policyHash, content.evidenceRevision, content.evidenceHash,
      content.workflowId, content.workflowRunId, JSON.stringify(content.reasonCodes),
      JSON.stringify(content.artifactRefs), content.payload, contentHash],
  );
  return eventRow(rows[0]);
}

interface DbApplicationRow {
  id: string; document_key: string; document_hash: string; mode: ApplicationMode;
  revision: number; parent_application_id: string | null; workflow_id: string; workflow_run_id: string | null;
  policy_version: string; policy_hash: string; status: string; stage: string; evidence_revision: number;
  audit_committed: boolean; data: Record<string, unknown>; created_at: Date; updated_at: Date;
}
interface DbReviewRow {
  application_id: string; case_revision: number; evidence_revision: number; policy_version: string;
  workflow_id: string; workflow_run_id: string; status: 'OPEN' | 'CLOSED'; overdue: boolean;
  payload: Record<string, unknown>; opened_at: Date; updated_at: Date;
}
interface DbEventRow {
  event_id: string; application_id: string; application_revision: number; sequence: number; occurred_at: Date;
  actor_type: string; actor_id: string | null; event_type: string; policy_version: string; policy_hash: string;
  evidence_revision: number | null; evidence_hash: string | null; workflow_id: string; workflow_run_id: string | null;
  reason_codes: string[]; artifact_refs: ArtifactRef[]; payload: Record<string, unknown>;
}
interface DbCommandRow {
  application_id: string; command_id: string; reviewer_id: string; status: 'accepted' | 'rejected';
  status_code: number; request_hash: string | null; payload: Record<string, unknown>;
  result: Record<string, unknown>; created_at: Date;
}
function applicationRow(row: DbApplicationRow): ApplicationProjection {
  return {
    id: row.id, documentKey: row.document_key, documentHash: row.document_hash, mode: row.mode,
    revision: row.revision, parentApplicationId: row.parent_application_id,
    workflowId: row.workflow_id, workflowRunId: row.workflow_run_id,
    policyVersion: row.policy_version, policyHash: row.policy_hash,
    status: row.status, stage: row.stage, evidenceRevision: row.evidence_revision,
    auditCommitted: row.audit_committed, data: row.data,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function reviewRow(row: DbReviewRow): ReviewCase {
  return {
    applicationId: row.application_id, caseRevision: row.case_revision,
    evidenceRevision: row.evidence_revision, policyVersion: row.policy_version,
    workflowId: row.workflow_id, workflowRunId: row.workflow_run_id, status: row.status,
    overdue: row.overdue, payload: row.payload, openedAt: iso(row.opened_at), updatedAt: iso(row.updated_at),
  };
}
function eventRow(row: DbEventRow): AuditEvent {
  return {
    eventId: row.event_id, applicationId: row.application_id, applicationRevision: row.application_revision,
    sequence: row.sequence, timestamp: iso(row.occurred_at), actorType: row.actor_type, actorId: row.actor_id,
    type: row.event_type, policyVersion: row.policy_version, policyHash: row.policy_hash,
    evidenceRevision: row.evidence_revision, evidenceHash: row.evidence_hash,
    workflowId: row.workflow_id, workflowRunId: row.workflow_run_id,
    reasonCodes: row.reason_codes, artifactRefs: row.artifact_refs, payload: row.payload,
  };
}
function commandRow(row: DbCommandRow): CommandAudit {
  return {
    applicationId: row.application_id, commandId: row.command_id, reviewerId: row.reviewer_id,
    status: row.status, statusCode: row.status_code, requestHash: row.request_hash ?? undefined,
    payload: row.payload, result: row.result, createdAt: iso(row.created_at),
  };
}
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
export function hashBytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
function assertArtifactKey(key: string): void {
  if (!key || key.startsWith('/') || key.split('/').includes('..') || key.includes('\\')) {
    throw new Error('Invalid stable artifact key');
  }
}
function hasErrorName(error: unknown, names: string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}
function getStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}
function isNotFound(error: unknown): boolean {
  return hasErrorName(error, ['NoSuchKey', 'NotFound', 'NoSuchBucket']) || getStatus(error) === 404;
}
