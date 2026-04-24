import type { Role, User } from '@prisma/client';
import { prisma } from './db';
import { ForbiddenError, UnauthorizedError } from './errors';
import { readSessionToken, setSessionCookie } from './cookies';
import { validateSessionToken, type SessionRow } from './session';

export type AuthedContext = {
  user: User & { org: { id: string; name: string } | null };
  session: SessionRow;
};

/**
 * Read the session cookie, validate it, and return the user + session.
 * Returns null when no cookie is present or the session is invalid/expired.
 *
 * Side-effect: refreshes the cookie expiry when sliding-extend fires.
 */
export async function getCurrentSession(): Promise<AuthedContext | null> {
  const token = readSessionToken();
  if (!token) return null;

  const result = await validateSessionToken(token);
  if (!result.session) return null;

  if (result.refreshed) {
    setSessionCookie(token, result.session.expiresAt);
  }

  // Hydrate org for serializer convenience.
  const user = await prisma.user.findUnique({
    where: { id: result.user.id },
    include: { org: { select: { id: true, name: true } } },
  });
  if (!user) return null;

  return { user, session: result.session };
}

export async function requireSession(): Promise<AuthedContext> {
  const ctx = await getCurrentSession();
  if (!ctx) throw new UnauthorizedError();
  return ctx;
}

export async function requireRole(...roles: Role[]): Promise<AuthedContext> {
  const ctx = await requireSession();
  if (!roles.includes(ctx.user.role)) {
    throw new ForbiddenError(`Role ${ctx.user.role} is not permitted`);
  }
  return ctx;
}
