import { sha256 } from '@oslojs/crypto/sha2';
import {
  encodeBase32LowerCaseNoPadding,
  encodeHexLowerCase,
} from '@oslojs/encoding';
import type { User } from '@prisma/client';
import { prisma } from './db';

// Implementation follows lucia-auth.com/sessions/basic verbatim:
//   - Token is 20 random bytes, base32-encoded (cookie value).
//   - Session.id stored in DB is SHA-256(token), hex-encoded — NEVER the raw token.
//   - 30-day absolute expiry; sliding refresh when <15 days remain.

const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_REFRESH_THRESHOLD_MS = 1000 * 60 * 60 * 24 * 15; // 15 days

export type SessionRow = {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type SessionValidationResult =
  | { session: SessionRow; user: User; refreshed: boolean }
  | { session: null; user: null; refreshed: false };

export function generateSessionToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return encodeBase32LowerCaseNoPadding(bytes);
}

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

export async function createSession(token: string, userId: string): Promise<SessionRow> {
  const id = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  return prisma.session.create({
    data: { id, userId, expiresAt },
  });
}

export async function validateSessionToken(token: string): Promise<SessionValidationResult> {
  const id = hashToken(token);
  const row = await prisma.session.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!row) return { session: null, user: null, refreshed: false };

  // Expired → delete and reject.
  if (Date.now() >= row.expiresAt.getTime()) {
    await prisma.session.delete({ where: { id } }).catch(() => undefined);
    return { session: null, user: null, refreshed: false };
  }

  // Sliding refresh when <15 days remaining.
  let refreshed = false;
  let expiresAt = row.expiresAt;
  if (row.expiresAt.getTime() - Date.now() < SESSION_REFRESH_THRESHOLD_MS) {
    expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    await prisma.session.update({
      where: { id },
      data: { expiresAt },
    });
    refreshed = true;
  }

  const { user, ...session } = row;
  return {
    session: { ...session, expiresAt },
    user,
    refreshed,
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

export async function invalidateUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Test/admin helper — derive Session.id from a known token. */
export function sessionIdFromToken(token: string): string {
  return hashToken(token);
}
