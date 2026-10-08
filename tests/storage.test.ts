import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ApplicationAdmissionError, ArtifactStore, PgStore, hashBytes } from '../src/storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const objectEndpoint = process.env.TEST_S3_ENDPOINT;

describe.skipIf(!databaseUrl)('PostgreSQL persistence with the restricted application role', () => {
  const store = new PgStore(databaseUrl!);
  const prefix = `storage-test-${randomUUID()}`;
  let nextId = 0;
  const newApplication = async () => {
    const id = `${prefix}-${++nextId}`;
    return store.createApplication({
      id, documentKey: 'documents/synthetic-test.pdf', documentHash: 'a'.repeat(64),
      mode: 'fixture', workflowId: `app-${id}`, workflowRunId: `run-${id}`,
      policyVersion: 'demo-auto-loan-v1', policyHash: 'b'.repeat(64),
    });
  };
  afterAll(async () => {
    const pending = await store.pool.query(`SELECT id FROM applications WHERE id LIKE $1 AND audit_committed = false`, [`${prefix}%`]);
    for (const { id } of pending.rows) {
      await store.commitFinal({ applicationId: id, eventId: `${id}/test-cleanup`, status: 'CANCELLED', decisionAuthority: 'TEST_CLEANUP' });
    }
    await store.close();
  });

  it('commits final projection and final audit exactly once after acknowledgement loss', async () => {
    const app = await newApplication();
    const final = {
      applicationId: app.id, eventId: `${app.id}/final`, status: 'PASS' as const,
      originalRecommendation: { outcome: 'PASS' }, decisionAuthority: 'DEMO_POLICY',
      reasonCodes: [], evidenceRevision: 1, evidenceHash: 'c'.repeat(64),
    };
    const first = await store.commitFinal(final);
    const retry = await store.commitFinal(final);
    expect(first).toEqual(retry);
    expect(first.status).toBe('PASS');
    expect(first.auditCommitted).toBe(true);
    const audit = await store.getAudit(app.id);
    expect(audit?.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    expect(audit?.events.find((event) => event.type === 'FINAL_COMMITTED')?.payload.finalDecision).toBe('PASS');
    await expect(store.commitFinal({ ...final, status: 'FAIL' })).rejects.toThrow('Audit event ID conflict');
    await expect(store.commitFinal({ ...final, eventId: `${app.id}/different` }))
      .rejects.toThrow('already finalized');
  });

  it('rolls back the final event if the projection write fails', async () => {
    const app = await newApplication();
    await expect(store.commitFinal({
      applicationId: app.id, eventId: `${app.id}/final`, status: 'PASS', evidenceRevision: -1,
    })).rejects.toThrow();
    expect((await store.getAudit(app.id))?.events.map((event) => event.type)).toEqual(['UPLOADED']);
    expect((await store.getApplication(app.id))?.auditCommitted).toBe(false);
    await store.commitFinal({ applicationId: app.id, eventId: `${app.id}/final`, status: 'PASS', evidenceRevision: 1 });
    expect((await store.getAudit(app.id))?.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
  });

  it('preserves an already committed decision when a late cancellation races its acknowledgement', async () => {
    const app = await newApplication();
    const input = { applicationId: app.id, eventId: `${app.id}/final`, status: 'PASS' as const,
      originalRecommendation: { outcome: 'PASS' }, evidenceRevision: 1, evidenceHash: 'c'.repeat(64) };
    const committed = await store.commitFinal(input);
    const afterCancellation = await store.commitFinal({ applicationId: app.id,
      eventId: `${app.id}/final`, status: 'CANCELLED', decisionAuthority: 'operator', payload: { code: 'CANCELLED' } });
    expect(afterCancellation).toEqual(committed);
    expect(afterCancellation.status).toBe('PASS');
    expect(await store.commitFinal({ applicationId: app.id, eventId: `${app.id}/cancel-retry`,
      status: 'CANCELLED', actorType: 'operator', actorId: 'another-operator' })).toEqual(committed);
    const audit = await store.getAudit(app.id);
    expect(audit?.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    expect(audit?.events.find((event) => event.type === 'FINAL_COMMITTED')?.payload.finalDecision).toBe('PASS');
    expect(audit?.events.filter((event) => event.type === 'LATE_CANCELLATION')).toHaveLength(1);
    expect(audit?.events.find((event) => event.type === 'LATE_CANCELLATION')?.payload).toEqual({
      requestedStatus: 'CANCELLED', retainedStatus: 'PASS', code: 'COMMITTED_OUTCOME_RETAINED',
    });
    await expect(store.commitFinal({ ...input, status: 'FAIL' })).rejects.toThrow('Audit event ID conflict');
  });

  it('keeps already committed cancellation idempotent without a late cancellation record', async () => {
    const app = await newApplication();
    const first = await store.commitFinal({ applicationId: app.id, eventId: `${app.id}/final`, status: 'CANCELLED' });
    expect(await store.commitFinal({ applicationId: app.id, eventId: `${app.id}/retry`, status: 'CANCELLED' })).toEqual(first);
    const audit = await store.getAudit(app.id);
    expect(audit?.events.filter((event) => event.type === 'FINAL_COMMITTED')).toHaveLength(1);
    expect(audit?.events.filter((event) => event.type === 'LATE_CANCELLATION')).toHaveLength(0);
  });

  it('keeps per-application sequences ordered under concurrent writes and deduplicates retries', async () => {
    const app = await newApplication();
    const inputs = Array.from({ length: 12 }, (_, index) => ({
      applicationId: app.id, eventId: `${app.id}/${index}`, type: 'ACTIVITY_COMPLETED', payload: { index },
    }));
    await Promise.all(inputs.map((input) => store.recordEvent(input)));
    await Promise.all(inputs.map((input) => store.recordEvent(input)));
    const audit = await store.getAudit(app.id);
    expect(audit?.events.map((event) => event.sequence)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(new Set(audit?.events.map((event) => event.eventId)).size).toBe(13);
  });

  it('denies audit update/delete and table creation to the app role', async () => {
    const app = await newApplication();
    await store.recordEvent({ applicationId: app.id, eventId: `${app.id}/upload`, type: 'UPLOADED' });
    await expect(store.pool.query('UPDATE audit_events SET actor_id = $1 WHERE application_id = $2', ['tamper', app.id]))
      .rejects.toThrow('permission denied');
    await expect(store.pool.query('DELETE FROM audit_events WHERE application_id = $1', [app.id]))
      .rejects.toThrow('permission denied');
    await expect(store.pool.query(`CREATE TABLE forbidden_runtime_table (id integer)`)).rejects.toThrow('permission denied');
  });

  it('records rejected API commands and returns the same result for a retry', async () => {
    const app = await newApplication();
    const input = {
      applicationId: app.id, commandId: 'stale-command', reviewerId: 'reviewer-demo',
      status: 'rejected' as const, statusCode: 409, requestHash: 'same-content',
      result: { code: 'STALE_REVISION' },
    };
    const first = await store.recordCommand(input);
    expect(await store.recordCommand(input)).toEqual(first);
    await expect(store.recordCommand({ ...input, requestHash: 'changed-content' })).rejects.toThrow('reused');
    expect((await store.getAudit(app.id))?.commands).toHaveLength(1);
  });

  it('revises review metadata and its audit event together, preserving workflow and policy binding', async () => {
    const app = await newApplication();
    const input = {
      applicationId: app.id, caseRevision: 1, evidenceRevision: 1, policyVersion: app.policyVersion,
      workflowId: app.workflowId, workflowRunId: app.workflowRunId!, payload: { reason: 'CREDIT_BORDERLINE' },
    };
    await store.openReviewCase(input);
    await store.openReviewCase(input);
    expect((await store.getAudit(app.id))?.events.map((event) => event.type)).toEqual(['UPLOADED', 'REVIEW_OPENED']);
    await expect(store.openReviewCase({ ...input, workflowRunId: 'another-run' })).rejects.toThrow('binding');
    const competing = await Promise.allSettled([
      store.openReviewCase({ ...input, caseRevision: 2, evidenceRevision: 2, payload: { reviewer: 'first' } }),
      store.openReviewCase({ ...input, caseRevision: 2, evidenceRevision: 2, payload: { reviewer: 'second' } }),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.getReviewCase(app.id))?.caseRevision).toBe(2);
    expect((await store.getAudit(app.id))?.events).toHaveLength(3);
    await expect(store.openReviewCase(input)).rejects.toThrow('revision conflict');
    await store.commitFinal({ applicationId: app.id, eventId: `${app.id}/final`, status: 'PASS' });
    expect((await store.getReviewCase(app.id))?.status).toBe('CLOSED');
    await expect(store.openReviewCase({ ...input, caseRevision: 3 })).rejects.toThrow('completed');
  });

  it('enforces the active application admission limit inside a shared database lock', async () => {
    // The test does not assume the database has no other active applications.
    const result = await store.pool.query('SELECT count(*)::integer AS active FROM applications WHERE audit_committed = false');
    const limit = result.rows[0].active + 1;
    const create = (suffix: string) => store.createApplication({
      id: `${prefix}-admission-${suffix}`, documentKey: 'documents/synthetic.pdf', documentHash: 'a'.repeat(64),
      mode: 'fixture', workflowId: `${prefix}-workflow-${suffix}`, policyVersion: 'demo-auto-loan-v1',
      policyHash: 'b'.repeat(64), admissionLimit: limit,
    });
    const results = await Promise.allSettled([create('a'), create('b')]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((item) => item.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason instanceof ApplicationAdmissionError).toBe(true);
  });

  it('shares only hashed opaque reviewer sessions across API instances and respects expiry', async () => {
    const tokenHash = hashBytes(Buffer.from(randomUUID()));
    const identity = { id: 'demo-reviewer', displayName: 'Demo reviewer', role: 'reviewer' as const };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await store.putReviewerSession({ tokenHash, identity, expiresAt });
    const otherReplica = new PgStore(databaseUrl!);
    try {
      expect(await otherReplica.getReviewerSession(tokenHash)).toEqual({ identity, expiresAt });
      await expect(otherReplica.pool.query('UPDATE reviewer_sessions SET identity = $1 WHERE token_hash = $2', [{ id: 'unauthorized' }, tokenHash]))
        .rejects.toThrow('permission denied');
      await otherReplica.deleteReviewerSession(tokenHash);
      expect(await store.getReviewerSession(tokenHash)).toBeNull();
      const expiredHash = hashBytes(Buffer.from(randomUUID()));
      await otherReplica.putReviewerSession({ tokenHash: expiredHash, identity, expiresAt: new Date(Date.now() - 60_000).toISOString() });
      expect(await store.getReviewerSession(expiredHash)).toBeNull();
    } finally { await otherReplica.close(); }
  });
});

describe.skipIf(!objectEndpoint)('S3-compatible immutable artifacts', () => {
  const store = new ArtifactStore({ endpoint: objectEndpoint });
  afterAll(() => store.close());

  it('reuses identical bytes and rejects conflicting writes, including simultaneous writers', async () => {
    await store.ensureBucket();
    const key = `storage-tests/${randomUUID()}/immutable.json`;
    const data = { z: 2, a: 1 };
    const first = await store.putJsonImmutable(key, data);
    const retry = await store.putJsonImmutable(key, { a: 1, z: 2 });
    expect(retry).toEqual(first);
    expect(await store.getJson(key)).toEqual(data);
    expect(hashBytes(await store.getBytes(key))).toBe(first.sha256);
    await expect(store.putJsonImmutable(key, { a: 99 })).rejects.toThrow('Immutable artifact conflict');
    const racingKey = `storage-tests/${randomUUID()}/race.txt`;
    const results = await Promise.allSettled([
      store.putImmutable(racingKey, Buffer.from('first'), 'text/plain'),
      store.putImmutable(racingKey, Buffer.from('second'), 'text/plain'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const persisted = (await store.getBytes(racingKey)).toString();
    expect(['first', 'second']).toContain(persisted);
  });
});
