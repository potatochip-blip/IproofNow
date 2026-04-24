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
