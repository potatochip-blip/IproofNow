import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as auditQuery } from '@/app/api/audit/route';
import { writeAudit } from '@/lib/audit';
import { createTestUser, db, loginAs, truncateAll } from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

function auditReq(qs = '') {
  return new Request(`http://localhost/api/audit${qs}`) as NextRequest;
}

describe('GET /api/audit', () => {
  it('non-admin sees only own rows', async () => {
    const { user: mine } = await createTestUser();
    const { user: theirs } = await createTestUser({ email: 'them@iproofnow.dev' });

    await writeAudit({
      actorUserId: mine.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
    });
    await writeAudit({
      actorUserId: theirs.id,
      entityType: 'Proof',
      entityId: 'p2',
      action: 'proof.created',
    });

    await loginAs(mine.id);
    const res = await auditQuery(auditReq('?action=proof.created'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].entityId).toBe('p1');
  });

  it('ADMIN sees everyone', async () => {
    const { user: admin } = await createTestUser({
      email: 'admin@iproofnow.dev',
      role: 'ADMIN',
    });
    const { user: other } = await createTestUser({ email: 'other@iproofnow.dev' });

    await writeAudit({
      actorUserId: other.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
    });
    await writeAudit({
      actorUserId: admin.id,
      entityType: 'Proof',
      entityId: 'p2',
      action: 'proof.created',
    });

    await loginAs(admin.id);
    const res = await auditQuery(auditReq('?action=proof.created'));
    const body = await res.json();
    const entityIds = body.events.map((e: { entityId: string }) => e.entityId).sort();
    expect(entityIds).toEqual(['p1', 'p2']);
  });

  it('filters compose: action + entityType', async () => {
    const { user } = await createTestUser();
    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
    });
    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p2',
      action: 'proof.updated',
    });
    await writeAudit({
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'proof.created',
    });

    await loginAs(user.id);
    const res = await auditQuery(auditReq('?action=proof.created&entityType=Proof'));
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].entityId).toBe('p1');
  });

  it('emits audit.queried with filterKeys', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);

    await auditQuery(auditReq('?action=proof.created&entityType=Proof'));

    const own = await db().auditLog.findFirst({
      where: { actorUserId: user.id, action: 'audit.queried' },
      orderBy: { createdAt: 'desc' },
    });
    expect(own).toBeTruthy();
    const meta = own?.meta as { filterKeys: string[]; scope: string };
    expect(meta.filterKeys.sort()).toEqual(['action', 'entityType']);
    expect(meta.scope).toBe('self');
  });

  it('401 without session', async () => {
    const res = await auditQuery(auditReq());
    expect(res.status).toBe(401);
  });
});
