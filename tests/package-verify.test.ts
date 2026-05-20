import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as verifyPackage } from '@/app/api/packages/[packageId]/verify/route';
import {
  createTestCase,
  createTestOrg,
  createTestPackage,
  createTestUser,
  db,
  joinOrg,
  loginAs,
  truncateAll,
} from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

function req(packageId: string) {
  return new Request(
    `http://localhost/api/packages/${packageId}/verify`
  ) as NextRequest;
}
function ctx(packageId: string) {
  return { params: { packageId } };
}

describe('GET /api/packages/:packageId/verify', () => {
  it('returns signed:false for a legacy unsigned READY package', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const pkg = await createTestPackage(user.id, {
      caseId: c.id,
      status: 'READY',
      storagePath: 'packages/legacy.zip',
    });

    const res = await verifyPackage(req(pkg.id), ctx(pkg.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signed).toBe(false);
  });

  it('returns signed:false for a PENDING package', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const pkg = await createTestPackage(user.id, { caseId: c.id, status: 'PENDING' });

    const res = await verifyPackage(req(pkg.id), ctx(pkg.id));
    const body = await res.json();
    expect(body.signed).toBe(false);
  });

  it('audits package.verified', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const pkg = await createTestPackage(user.id, { caseId: c.id, status: 'READY' });

    await verifyPackage(req(pkg.id), ctx(pkg.id));

    const audit = await db().auditLog.findFirst({
      where: { entityType: 'EvidencePackage', entityId: pkg.id, action: 'package.verified' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(user.id);
  });

  it('same-org member can verify a package', async () => {
    const ownerRes = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(ownerRes.user.id);
    await joinOrg(ownerRes.user.id, org.id);
    const c = await createTestCase(ownerRes.user.id, { orgId: org.id });
    const pkg = await createTestPackage(ownerRes.user.id, {
      caseId: c.id,
      status: 'READY',
    });

    const mate = await createTestUser({ email: 'mate@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(mate.user.id, org.id);
    await loginAs(mate.user.id);

    const res = await verifyPackage(req(pkg.id), ctx(pkg.id));
    expect(res.status).toBe(200);
  });

  it('404 for a stranger (no existence leak)', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);
    const pkg = await createTestPackage(owner.user.id, { caseId: c.id, status: 'READY' });

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await verifyPackage(req(pkg.id), ctx(pkg.id));
    expect(res.status).toBe(404);
  });

  it('404 for a missing package', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const res = await verifyPackage(req('no-such-package'), ctx('no-such-package'));
    expect(res.status).toBe(404);
  });

  it('401 without a session', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);
    const pkg = await createTestPackage(owner.user.id, { caseId: c.id, status: 'READY' });

    const res = await verifyPackage(req(pkg.id), ctx(pkg.id));
    expect(res.status).toBe(401);
  });
});
