import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = 'session';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Cookie strategy (CLAUDE.md → "Cookies & CORS"):
 *   - dev: sameSite=lax, secure=false. Frontend uses Next rewrites to proxy
 *     /api/* same-origin → cookies attach without CORS dance.
 *   - prod: sameSite=none, secure=true. Cross-origin (api.* + app.*) requires
 *     SameSite=None + Secure for browsers to attach the cookie at all.
 *
 * Phase 6 note — privilege rotation:
 *   No code path in Phases 1–6 changes a session's effective role mid-
 *   session. requireRole() throws ForbiddenError on mismatch but never
 *   mutates the user. There's no "elevate to admin" or "switch role"
 *   surface. So a session-cookie rotation step (rotateSessionCookieOn-
 *   PrivilegeChange) would have nothing to react to.
 *
 *   TODO(phase-share): when the share-grant flow lands and a non-owner
 *   gains access to a Case via an explicit grant, the new effective
 *   capability set means we should rotate the session token to invalidate
 *   any pre-grant copies. Wire it into the share-grant POST handler.
 */
export function setSessionCookie(token: string, expiresAt: Date): void {
  cookies().set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: isProd() ? 'none' : 'lax',
    secure: isProd(),
    path: '/',
    expires: expiresAt,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(): void {
  cookies().set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: isProd() ? 'none' : 'lax',
    secure: isProd(),
    path: '/',
    maxAge: 0,
  });
}

export function readSessionToken(): string | null {
  return cookies().get(SESSION_COOKIE_NAME)?.value ?? null;
}
