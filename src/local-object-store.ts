import S3rver from 's3rver';
import { mkdir } from 'node:fs/promises';
import { installImmutableS3Middleware } from './db/s3rver-immutable.js';
const directory = process.env.OBJECT_DIRECTORY ?? '/data/objects';
await mkdir(directory, { recursive: true });
const server = new S3rver({
  address: '0.0.0.0', port: 9000, directory, silent: true, vhostBuckets: false,
  configureBuckets: [{ name: 'loan-artifacts', configs: [] }],
});
installImmutableS3Middleware(server);
await server.run();
console.log('Local S3-compatible development object store listening on port 9000.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
