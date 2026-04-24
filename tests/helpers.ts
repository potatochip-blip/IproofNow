import { PrismaClient, type Role, type User } from '@prisma/client';
import { hashPassword } from '@/lib/password';
import { createSession, generateSessionToken } from '@/lib/session';
import { seedCookie } from './cookie-jar';
import { SESSION_COOKIE_NAME } from '@/lib/cookies';

// One client for all tests — vitest forks isolate between files but share
// inside a file. singleFork in vitest.config.ts keeps DB ops linear.
let prisma: PrismaClient | undefined;
export function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

/** Wipe all rows between tests. Order matters: child tables first. */
export async function truncateAll(): Promise<void> {
  const p = db();
  await p.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog","VerificationRecord","CaseProof","EvidencePackage",
      "ProofAttestation","ProofFile","PreservationConfig","Notification",
      "Proof","Case","Session","Organization","User"
    RESTART IDENTITY CASCADE;
  `);
}

export async function createTestUser(opts: {
  email?: string;
  name?: string;
  role?: Role;
  password?: string;
} = {}): Promise<{ user: User; password: string }> {
  const password = opts.password ?? 'test-password-123';
  const passwordHash = await hashPassword(password);
  const user = await db().user.create({
    data: {
      email: opts.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@iproofnow.dev`,
      name: opts.name ?? 'Test User',
      role: opts.role ?? 'INDIVIDUAL',
      passwordHash,
    },
  });
  return { user, password };
}

/** Create a session for the user and seed the cookie jar so guards see it. */
export async function loginAs(userId: string): Promise<{ token: string; sessionId: string }> {
  const token = generateSessionToken();
  const session = await createSession(token, userId);
  seedCookie(SESSION_COOKIE_NAME, token);
  return { token, sessionId: session.id };
}

/** Build a NextRequest-compatible Request. */
export function buildJsonRequest(
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
