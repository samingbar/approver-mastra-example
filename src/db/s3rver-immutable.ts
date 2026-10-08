/**
 * S3rver 3.7.1 implements conditional GET, but not conditional PUT. This local
 * adapter supplies the atomic If-None-Match:* contract used by ArtifactStore.
 * All replicas use this one object service; its per-key lock includes the write.
 * Real S3/MinIO enforce conditional PUT themselves and do not use this module.
 */
interface ObjectContext {
  method: string;
  path: string;
  query: Record<string, unknown>;
  get(name: string): string;
  type: string;
  status: number;
  body: unknown;
  req: { resume(): unknown };
}

interface LocalS3Server {
  middleware: Array<(context: ObjectContext, next: () => Promise<unknown>) => Promise<unknown>>;
  store: { getMetadata(bucket: string, key: string): Promise<unknown> };
}

export function installImmutableS3Middleware(value: unknown): void {
  // S3rver's public declaration omits the inherited middleware and local store.
  const server = value as LocalS3Server;
  if (!server || !Array.isArray(server.middleware) || typeof server.store?.getMetadata !== 'function') {
    throw new Error('Pinned S3rver middleware/store contract changed');
  }
  const locks = new Map<string, Promise<void>>();
  server.middleware.unshift(async (context, next) => {
    const match = /^\/([^/]+)\/(.+)$/.exec(context.path);
    if (context.method !== 'PUT' || !match || context.query['tagging'] !== undefined
        || context.query['acl'] !== undefined || context.query['uploadId'] !== undefined) {
      return next();
    }
    const bucket = decodeURIComponent(match[1]!);
    const key = decodeURIComponent(match[2]!);
    if (context.get('if-none-match') !== '*') {
      return rejectConditionalPut(context, 428, 'PreconditionRequired', 'Immutable objects require If-None-Match:*');
    }
    const lockKey = `${bucket}/${key}`;
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    locks.set(lockKey, pending);
    await previous;
    try {
      try {
        await server.store.getMetadata(bucket, key);
        return rejectConditionalPut(context, 412, 'PreconditionFailed', 'The specified object already exists');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // S3rver resolves its controller only after content and metadata are saved.
      return await next();
    } finally {
      release();
      if (locks.get(lockKey) === pending) locks.delete(lockKey);
    }
  });
}

function rejectConditionalPut(context: ObjectContext, status: number, code: string, message: string): void {
  context.req.resume();
  context.status = status;
  context.type = 'application/xml';
  context.body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}
