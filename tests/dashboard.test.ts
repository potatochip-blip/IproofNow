import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as dashboardRoute } from '@/app/api/dashboard/route';
import { requireRole } from '@/lib/guards';
import {
  createTestUser,
  db,
  loginAs,
  truncateAll,
} from './helpers';
import { errorResponse } from '@/lib/errors';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db().$disconnect();
});

describe('GET /api/dashboard', () => {
  it('401 without session', async () => {
    const res = await dashboardRoute();
    expect(res.status).toBe(401);
  });

  it('200 with all-zero stats on empty DB (INDIVIDUAL)', async () => {
    const { user } = await createTestUser({ role: 'INDIVIDUAL' });
    await loginAs(user.id);

    const res = await dashboardRoute();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.role).toBe('individual');
    expect(body.stats).toEqual({
      totalProofs: 0,
      sealedProofs: 0,
      recentVerifications: 0,
    });
    expect(body.recentProofs).toEqual([]);
    expect(body.recentActivity).toEqual([]);
    expect(body.notificationsSummary).toEqual({ unread: 0, total: 0 });
    expect(body.roleWidgets).toEqual({ personalProofs: 0 });
  });

  it('reflects real Postgres queries — counts proofs and notifications', async () => {
    const { user } = await createTestUser({ role: 'INDIVIDUAL' });
    await loginAs(user.id);

    await db().proof.createMany({
      data: [
        { ownerUserId: user.id, title: 'P1', categoryKey: 'misc', proofType: 'text' },
        { ownerUserId: user.id, title: 'P2', categoryKey: 'misc', proofType: 'text', status: 'SEALED', sealedAt: new Date() },
      ],
    });
    await db().notification.createMany({
      data: [
        { userId: user.id, type: 'proof.created', title: 'a', body: 'b' },
        { userId: user.id, type: 'proof.sealed',  title: 'c', body: 'd', readAt: new Date() },
      ],
    });

    const res = await dashboardRoute();
    const body = await res.json();

    expect(body.stats.totalProofs).toBe(2);
    expect(body.stats.sealedProofs).toBe(1);
    expect(body.recentProofs).toHaveLength(2);
    expect(body.notificationsSummary).toEqual({ unread: 1, total: 2 });
    expect(body.roleWidgets.personalProofs).toBe(2);
  });

  it('admin role widgets return totalUsers + totalOrgs', async () => {
    const { user } = await createTestUser({ role: 'ADMIN', email: 'admin1@iproofnow.dev' });
    await createTestUser({ role: 'INDIVIDUAL', email: 'a@iproofnow.dev' });
    await createTestUser({ role: 'INDIVIDUAL', email: 'b@iproofnow.dev' });
    await loginAs(user.id);

    const res = await dashboardRoute();
    const body = await res.json();

    expect(body.role).toBe('admin');
    expect(body.roleWidgets.totalUsers).toBe(3);
    expect(body.roleWidgets.totalOrgs).toBe(0);
  });
});

describe('requireRole guard', () => {
  // Inline test handler so we don't need a dedicated admin-only route yet.
  async function adminOnly() {
    try {
      await requireRole('ADMIN');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } catch (err) {
      return errorResponse(err);
    }
  }

  it('rejects non-admin with 403', async () => {
    const { user } = await createTestUser({ role: 'INDIVIDUAL' });
    await loginAs(user.id);

    const res = await adminOnly();
    expect(res.status).toBe(403);
  });

  it('allows admin', async () => {
    const { user } = await createTestUser({ role: 'ADMIN' });
    await loginAs(user.id);

    const res = await adminOnly();
    expect(res.status).toBe(200);
  });
});
