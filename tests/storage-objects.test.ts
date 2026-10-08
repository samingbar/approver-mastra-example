import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import S3rver from 's3rver';
import { ArtifactStore, hashBytes } from '../src/storage.js';
import { installImmutableS3Middleware } from '../src/db/s3rver-immutable.js';

describe('immutable local S3 service with actual concurrent HTTP clients', () => {
  let directory: string;
  let server: S3rver;
  let objects: ArtifactStore;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'loan-s3-test-'));
    server = new S3rver({ address: '127.0.0.1', port: 0, directory, silent: true });
    installImmutableS3Middleware(server);
    const address = await server.run();
    if (typeof address === 'string') throw new Error('Expected TCP local object service');
    objects = new ArtifactStore({ endpoint: `http://127.0.0.1:${address.port}`, bucket: 'loan-test-artifacts' });
    await objects.ensureBucket();
  });
  afterAll(async () => {
    objects?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('deduplicates identical artifact retries without permitting overwrite', async () => {
    const saved = await objects.putJsonImmutable('evidence/document/revision-1.json', { z: 2, a: 1 });
    expect(await objects.putJsonImmutable(saved.key, { a: 1, z: 2 })).toEqual(saved);
    await expect(objects.putJsonImmutable(saved.key, { a: 99 })).rejects.toThrow('Immutable artifact conflict');
    expect(await objects.getJson(saved.key)).toEqual({ a: 1, z: 2 });
    expect(hashBytes(await objects.getBytes(saved.key))).toBe(saved.sha256);
  });

  it('allows only one of simultaneous conflicting writers to win', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      objects.putImmutable('ocr/document/page-1.txt', Buffer.from(`result-${i}`), 'text/plain')));
    const successful = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(successful).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(7);
    const saved = (await objects.getBytes('ocr/document/page-1.txt')).toString();
    expect(saved).toMatch(/^result-[0-7]$/);
    expect(await objects.exists('ocr/document/page-1.txt')).toBe(true);
    expect(await objects.exists('ocr/document/page-absent.txt')).toBe(false);
  });

  it('allows identical writers to share one artifact', async () => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      objects.putImmutable('images/document/page-1.png', Buffer.from('same rendered bytes'), 'image/png')));
    expect(new Set(attempts.map((result) => result.sha256)).size).toBe(1);
    expect(new Set(attempts.map((result) => result.key)).size).toBe(1);
  });
});
