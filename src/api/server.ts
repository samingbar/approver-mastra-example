import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { ArtifactStore, PgStore } from '../storage.js';
import { createApi, readFixtureHashes, reconcilePendingStarts, type ApiDependencies } from './app.js';
import { readApiConfig } from './config.js';
import { connectWorkflowClient } from './temporal-client.js';
import { passwordSessions } from './auth.js';

async function main(): Promise<void> {
  const config = readApiConfig();
  if (config.mode === 'live' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new Error('The local live server must bind to loopback. Shared deployment requires a trusted TLS/authentication service and is outside this local build.');
  }
  const database = new PgStore();
  const auth = config.mode === 'live' ? await passwordSessions(config.reviewerUsersPath, database) : undefined;
  const artifacts = new ArtifactStore();
  await database.ping();
  const temporal = await connectWorkflowClient();
  const dependencies: ApiDependencies = {
    config, database, artifacts, workflows: temporal.workflows,
    knownFixtureHashes: await readFixtureHashes(config.fixtureManifestPath),
    ...(auth ? { authenticate: auth.authenticate, login: auth.login, logout: auth.delete } : {}),
  };
  const app = await createApi(dependencies);
  const uiRoot = resolve(config.uiDistPath);
  if (existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ code: 'NOT_FOUND' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => {
    await temporal.close();
    await database.close();
    artifacts.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close(); });
  }
  await app.listen({ host: config.host, port: config.port });
  await reconcilePendingStarts(dependencies);
  console.log(`Local ${config.mode} loan review API: http://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  // Error text never includes request documents, sessions, database URLs, or credentials.
  console.error(error instanceof Error ? error.message.replace(/(?:postgresql?|https?):\/\/[^\s]+/g, '[service address]') : 'API startup failed');
  process.exitCode = 1;
});
