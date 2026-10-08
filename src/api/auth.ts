import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface ReviewerIdentity {
  id: string;
  displayName: string;
  role: 'reviewer' | 'override-reviewer';
  /** A production authenticator must explicitly grant case access. */
  applicationIds?: readonly string[];
}

export const fixtureReviewers: readonly ReviewerIdentity[] = [
  { id: 'demo-reviewer', displayName: 'Demo reviewer', role: 'reviewer' },
  { id: 'demo-supervisor', displayName: 'Demo override reviewer', role: 'override-reviewer' },
];

export type AuthenticateReviewer = (request: FastifyRequest) => Promise<ReviewerIdentity | null>;

export interface SessionStore {
  putReviewerSession(input: { tokenHash: string; identity: ReviewerIdentity; expiresAt: string }): Promise<void>;
  getReviewerSession(tokenHash: string): Promise<{ identity: ReviewerIdentity; expiresAt: string } | null>;
  deleteReviewerSession(tokenHash: string): Promise<void>;
}
const identitySchema = z.object({
  id: z.string().min(1), displayName: z.string().min(1), role: z.enum(['reviewer', 'override-reviewer']),
  applicationIds: z.array(z.string()).optional(),
}).strict();
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Local fixture identities are selected by name, then held in an opaque server session. */
function reviewerSessions(store: SessionStore) {
  return {
    async create(identity: ReviewerIdentity): Promise<string> {
      const token = randomBytes(32).toString('hex');
      await store.putReviewerSession({ tokenHash: tokenHash(token), identity, expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() });
      return token;
    },
    async authenticate(request: FastifyRequest): Promise<ReviewerIdentity | null> {
      const token = request.cookies['loan-review-session'];
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
      const session = await store.getReviewerSession(tokenHash(token));
      if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
        if (session) await store.deleteReviewerSession(tokenHash(token));
        return null;
      }
      return identitySchema.parse(session.identity);
    },
    async delete(token: string | undefined): Promise<void> {
      if (token) await store.deleteReviewerSession(tokenHash(token));
    },
  };
}

export function fixtureSessions(store: SessionStore) {
  const sessions = reviewerSessions(store);
  return {
    ...sessions,
    async create(reviewerId: string): Promise<string | null> {
      const identity = fixtureReviewers.find((reviewer) => reviewer.id === reviewerId);
      return identity ? sessions.create(identity) : null;
    },
  };
}

export const passwordUserSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/), displayName: z.string().min(1).max(100),
  role: z.enum(['reviewer', 'override-reviewer']),
  applicationIds: z.array(z.union([z.literal('*'), z.string().uuid()])).min(1),
  salt: z.string().regex(/^[a-f0-9]{32}$/), passwordHash: z.string().regex(/^[a-f0-9]{128}$/),
}).strict();
export const passwordUsersFileSchema = z.array(passwordUserSchema).min(1).max(100);
const deriveKey = promisify(scrypt);

export async function createPasswordHash(password: string, salt: string): Promise<string> {
  return (await deriveKey(password, salt, 64) as Buffer).toString('hex');
}

/** Local live mode has real passwords and explicit case grants, stored only on the server. */
export async function passwordSessions(usersFile: string, store: SessionStore) {
  let info;
  try { info = await stat(usersFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Create a local live reviewer with npm run reviewer:create before starting live mode. REVIEWER_USERS_FILE selects the owner-only password file.');
    throw error;
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Reviewer users file must have owner-only permissions (chmod 600).');
  }
  const users = passwordUsersFileSchema.parse(JSON.parse(await readFile(usersFile, 'utf8')));
  if (new Set(users.map((user) => user.id)).size !== users.length) throw new Error('Reviewer IDs must be unique.');
  const sessions = reviewerSessions(store);
  return {
    authenticate: sessions.authenticate,
    delete: sessions.delete,
    async login(reviewerId: string, password: string): Promise<{ token: string; identity: ReviewerIdentity } | null> {
      const user = users.find((candidate) => candidate.id === reviewerId);
      // Unknown users also perform scrypt to avoid a cheap username timing distinction.
      const salt = user?.salt ?? '00000000000000000000000000000000';
      const actual = Buffer.from(await createPasswordHash(password, salt), 'hex');
      const expected = Buffer.from(user?.passwordHash ?? '0'.repeat(128), 'hex');
      if (!timingSafeEqual(actual, expected) || !user) return null;
      const identity: ReviewerIdentity = { id: user.id, displayName: user.displayName, role: user.role, applicationIds: user.applicationIds };
      return { token: await sessions.create(identity), identity };
    },
  };
}

/** Case authorization is mandatory in live mode; fixture reviewers see local synthetic data. */
export function canAccessApplication(identity: ReviewerIdentity, applicationId: string, mode: 'fixture' | 'live'): boolean {
  return mode === 'fixture' || Boolean(identity.applicationIds?.includes(applicationId) || identity.applicationIds?.includes('*'));
}

/** Origin checking protects cookie authenticated commands without accepting browser credentials. */
export function isSameOrigin(request: FastifyRequest, allowedOrigin?: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // Local command line clients do not supply Origin.
  try {
    const expected = allowedOrigin ?? `${request.protocol}://${request.headers.host}`;
    const a = Buffer.from(new URL(origin).origin);
    const b = Buffer.from(new URL(expected).origin);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
