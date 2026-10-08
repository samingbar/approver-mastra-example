import { spawnSync } from 'node:child_process';
import { copyFile, access, appendFile } from 'node:fs/promises';
import { config as loadEnvironment } from 'dotenv';

try { await access('.env'); } catch { await copyFile('.env.example', '.env'); }
loadEnvironment({ quiet: true });
const buildEnvironment = { ...process.env };
const localAppPort = Number(buildEnvironment.LOCAL_APP_PORT ?? 3000);
if (!Number.isInteger(localAppPort) || localAppPort < 1 || localAppPort > 65535) {
  throw new Error('LOCAL_APP_PORT must be an integer from 1 to 65535.');
}
const engine = spawnSync('docker', ['info', '--format', '{{.Driver}}'], { encoding: 'utf8' });
if (engine.error || engine.status !== 0) {
  throw new Error('Docker with Compose is required. Start your local Docker engine and rerun npm run dev.');
}
if (process.platform === 'linux' && engine.stdout.trim() === 'vfs' && !buildEnvironment.COMPOSE_FILE) {
  await access('node_modules/@mastra/temporal/package.json');
  buildEnvironment.COMPOSE_FILE = 'compose.yaml:compose.vfs.yaml';
  // Keep later demo/scale commands on the same local configuration. No secret
  // values are read or rewritten; an explicitly selected configuration wins.
  await appendFile('.env', '\n# Linux vfs worker containers share locked local dependencies read-only.\nCOMPOSE_FILE=compose.yaml:compose.vfs.yaml\n');
  console.log('Using compact local workers for Docker vfs; pinned OCR engines and worker limits are unchanged.');
}
// Cloud machines can supply an authoritative public proxy CA. Ordinary local
// machines use the empty default; certificate and package verification stay on.
if (!buildEnvironment.LOCAL_CA_CERT_FILE && process.env.NODE_EXTRA_CA_CERTS) {
  await access(process.env.NODE_EXTRA_CA_CERTS);
  buildEnvironment.LOCAL_CA_CERT_FILE = process.env.NODE_EXTRA_CA_CERTS;
}
const result = spawnSync('docker', ['compose', 'up', '--build', '-d', '--wait', '--wait-timeout', '180'], {
  stdio: 'inherit', env: buildEnvironment,
});
if (result.error) throw new Error('Docker with Compose is required. Start your local Docker engine and rerun npm run dev.', { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Educational simulation running at http://localhost:${localAppPort}; Temporal UI at http://localhost:8233.`);
console.log('Stop: docker compose down. Persistent state survives restarts.');
