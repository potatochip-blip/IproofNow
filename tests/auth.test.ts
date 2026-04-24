import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { GET as sessionRoute } from '@/app/api/auth/session/route';
import { SESSION_COOKIE_NAME } from '@/lib/cookies';
import { sessionIdFromToken, generateSessionToken } from '@/lib/session';
import {
  buildJsonRequest,
  createTestUser,
  db,
  loginAs,
  truncateAll,
} from './helpers';
import { getCookieJar, resetCookieJar, seedCookie } from './cookie-jar';
import type { NextRequest } from 'next/server';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

describe('POST /api/auth/login', () => {
  it('happy path → 200, returns user, sets session cookie, writes audit', async () => {
    const { user, password } = await createTestUser({
      email: 'happy@iproofnow.dev',
      role: 'INDIVIDUAL',
    });

    const res = await loginRoute(
      buildJsonRequest('http://localhost/api/auth/login', 'POST', {
        email: user.email,
        password,
      }) as NextRequest
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe(user.email);
    expect(body.user.role).toBe('individual'); // lowercased at the boundary
    expect(body.user.subscriptionTier).toBe('free');
    expect(body.user.preferences.theme).toBe('system');
    expect(body.user.stats).toBeUndefined(); // stats live on /api/dashboard

    // Cookie jar received the session.
    const cookie = getCookieJar().get(SESSION_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);

    // Session row exists.
    const sessions = await db().session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);

    // Audit row written.
    const audit = await db().auditLog.findMany({ where: { actorUserId: user.id } });
    expect(audit.some((a) => a.action === 'auth.login.success')).toBe(true);
  });

  it('wrong password → 401 + audit failure', async () => {
    const { user } = await createTestUser({ email: 'bad@iproofnow.dev' });

    const res = await loginRoute(
      buildJsonRequest('http://localhost/api/auth/login', 'POST', {
        email: user.email,
        password: 'wrong',
      }) as NextRequest
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');

    const audit = await db().auditLog.findMany({ where: { actorUserId: user.id } });
    expect(audit.some((a) => a.action === 'auth.login.failure')).toBe(true);
  });

  it('unknown email → 401 + audit failure with null actor', async () => {
    const res = await loginRoute(
      buildJsonRequest('http://localhost/api/auth/login', 'POST', {
        email: 'ghost@iproofnow.dev',
        password: 'whatever',
      }) as NextRequest
    );

    expect(res.status).toBe(401);
    const audit = await db().auditLog.findMany({ where: { actorUserId: null } });
    expect(audit.some((a) => a.action === 'auth.login.failure')).toBe(true);
  });

  it('malformed body → 400 VALIDATION_ERROR', async () => {
    const res = await loginRoute(
      buildJsonRequest('http://localhost/api/auth/login', 'POST', {
        email: 'not-an-email',
        password: '',
      }) as NextRequest
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/auth/me', () => {
  it('401 without cookie', async () => {
    const res = await meRoute();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('200 with valid cookie, returns user + role', async () => {
    const { user } = await createTestUser({ role: 'LAWYER' });
    await loginAs(user.id);

    const res = await meRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(user.id);
    expect(body.role).toBe('lawyer');
  });

  it('rejects expired session', async () => {
    const { user } = await createTestUser();
    const token = generateSessionToken();
    // Insert an already-expired session manually.
    await db().session.create({
      data: {
        id: sessionIdFromToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    seedCookie(SESSION_COOKIE_NAME, token);

    const res = await meRoute();
    expect(res.status).toBe(401);

    // Expired row was cleaned up.
    const stillThere = await db().session.findUnique({
      where: { id: sessionIdFromToken(token) },
    });
    expect(stillThere).toBeNull();
  });
});

describe('GET /api/auth/session (alias)', () => {
  it('returns the same { user } shape the frontend reads', async () => {
    const { user } = await createTestUser({ role: 'COMPANY' });
    await loginAs(user.id);

    const res = await sessionRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
    expect(body.user.role).toBe('company');
    expect(body.role).toBeUndefined(); // session route omits role
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie, deletes the session row, writes audit', async () => {
    const { user } = await createTestUser();
    const { sessionId } = await loginAs(user.id);

    const res = await logoutRoute();
    expect(res.status).toBe(200);

    // Cookie cleared.
    expect(getCookieJar().get(SESSION_COOKIE_NAME)).toBeUndefined();

    // Row gone.
    const stillThere = await db().session.findUnique({ where: { id: sessionId } });
    expect(stillThere).toBeNull();

    // Audit written.
    const audit = await db().auditLog.findMany({ where: { actorUserId: user.id } });
    expect(audit.some((a) => a.action === 'auth.logout')).toBe(true);
  });

  it('idempotent — 200 even with no session', async () => {
    const res = await logoutRoute();
    expect(res.status).toBe(200);
  });
});
