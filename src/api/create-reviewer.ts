import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPasswordHash, passwordUserSchema, passwordUsersFileSchema } from './auth.js';

async function main(): Promise<void> {
  const [id, displayName = id, role = 'reviewer', ...applicationIds] = process.argv.slice(2);
  if (!id || applicationIds.length === 0) throw new Error('Usage: npm run reviewer:create -- ID "Display name" reviewer|override-reviewer APPLICATION_ID... (use * for an explicit all-applications grant). Pipe a password on stdin.');
  if (process.stdin.isTTY && !process.env['REVIEWER_PASSWORD']) throw new Error('Provide REVIEWER_PASSWORD securely or pipe a password on stdin; passwords are never command-line arguments.');
  let password = process.env['REVIEWER_PASSWORD'];
  if (!password) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  if (password.length < 12 || password.length > 1024) throw new Error('Use a reviewer password of 12–1024 characters.');
  const salt = randomBytes(16).toString('hex');
  const user = passwordUserSchema.parse({ id, displayName, role, applicationIds, salt, passwordHash: await createPasswordHash(password, salt) });
  const path = process.env['REVIEWER_USERS_FILE'] ?? '.local/reviewers.json';
  let users: ReturnType<typeof passwordUsersFileSchema.parse> = [];
  try { users = passwordUsersFileSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (users.some((existing) => existing.id === user.id)) throw new Error('This reviewer ID already exists; preserve it or explicitly remove it from the local users file before replacing credentials.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify([...users, user], null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
  console.log(`Created local reviewer ${user.id} with ${user.role} role and explicit case grants.`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Reviewer creation failed'); process.exitCode = 1; });
import 'dotenv/config';
