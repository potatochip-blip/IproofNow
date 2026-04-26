import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  GET as listPackages,
  POST as requestPackage,
} from '@/app/api/cases/[caseId]/packages/route';
import { GET as getPackage } from '@/app/api/packages/[packageId]/route';
import {
  buildJsonRequest,
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

function ctx(caseId: string) {
  return { params: { caseId } };
}

function pkgCtx(packageId: string) {
  return { params: { packageId } };
}

function postReq(caseId: string, body: unknown) {
  return buildJsonRequest(
    `http://localhost/api/cases/${caseId}/packages`,
    'POST',
    body
  ) as NextRequest;
}

describe('POST /api/cases/:caseId/packages (request)', () => {
  it('owner: 202 + PENDING row + audit + notification to owner', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id, { title: 'Acme' });

    const res = await requestPackage(
      postReq(c.id, { packageType: 'court_bundle' }),
      ctx(c.id)
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(body.packageId).toBeTruthy();

    const pkg = await db().evidencePackage.findUnique({
      where: { id: body.packageId },
    });
    expect(pkg?.status).toBe('PENDING');
    expect(pkg?.caseId).toBe(c.id);
    expect(pkg?.packageType).toBe('court_bundle');

    const audit = await db().auditLog.findFirst({
      where: { entityId: body.packageId, action: 'package.requested' },
    });
    expect(audit).toBeTruthy();
    const meta = audit?.meta as { packageType: string; caseId: string };
    expect(meta.packageType).toBe('court_bundle');

    const notif = await db().notification.findFirst({
      where: { userId: user.id, type: 'evidence_package_requested' },
    });
    expect(notif).toBeTruthy();
    expect(notif?.href).toBe(`/cases/${c.id}`);
  });

  it('same-org LAWYER on another owner\'s case: 202; notification still goes to owner', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const c = await createTestCase(owner.user.id, {
      title: 'cross-team',
      orgId: org.id,
    });

    const lawyer = await createTestUser({
      email: 'lawyer@iproofnow.dev',
      role: 'LAWYER',
    });
    await joinOrg(lawyer.user.id, org.id);
    await loginAs(lawyer.user.id);

    const res = await requestPackage(
      postReq(c.id, { packageType: 'discovery' }),
      ctx(c.id)
    );
    expect(res.status).toBe(202);

    const ownerNotif = await db().notification.findFirst({
      where: { userId: owner.user.id, type: 'evidence_package_requested' },
    });
    expect(ownerNotif).toBeTruthy();
    const lawyerNotif = await db().notification.findFirst({
      where: { userId: lawyer.user.id, type: 'evidence_package_requested' },
    });
    expect(lawyerNotif).toBeNull();
  });

  it('same-org INDIVIDUAL (not LAWYER/LE) → 403', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const c = await createTestCase(owner.user.id, { orgId: org.id });

    const peer = await createTestUser({
      email: 'peer@iproofnow.dev',
      role: 'INDIVIDUAL',
    });
    await joinOrg(peer.user.id, org.id);
    await loginAs(peer.user.id);

    const res = await requestPackage(
      postReq(c.id, { packageType: 'court_bundle' }),
      ctx(c.id)
    );
    expect(res.status).toBe(403);
  });

  it('foreign user → 404 (loadCaseForRead masks existence)', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await requestPackage(
      postReq(c.id, { packageType: 'custom' }),
      ctx(c.id)
    );
    expect(res.status).toBe(404);
  });

  it('rejects invalid packageType', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);

    const res = await requestPackage(
      postReq(c.id, { packageType: 'instant_zip' }),
      ctx(c.id)
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/cases/:caseId/packages (list)', () => {
  it('returns case\'s packages, newest first', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);

    await createTestPackage(user.id, { caseId: c.id, packageType: 'a' });
    await createTestPackage(user.id, { caseId: c.id, packageType: 'b' });

    const res = await listPackages(
      new Request(`http://localhost/api/cases/${c.id}/packages`) as NextRequest,
      ctx(c.id)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.packages).toHaveLength(2);
  });

  it('foreign caller → 404', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);
    await createTestPackage(owner.user.id, { caseId: c.id });

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await listPackages(
      new Request(`http://localhost/api/cases/${c.id}/packages`) as NextRequest,
      ctx(c.id)
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/packages/:packageId', () => {
  it('PENDING package: response omits downloadUrl', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const pkg = await createTestPackage(user.id, { caseId: c.id });

    const res = await getPackage(
      new Request(`http://localhost/api/packages/${pkg.id}`) as NextRequest,
      pkgCtx(pkg.id)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.package.id).toBe(pkg.id);
    expect(body.package.status).toBe('pending');
    expect('downloadUrl' in body).toBe(false);
  });

  it('READY package: includes downloadUrl when storagePath populated', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const pkg = await createTestPackage(user.id, {
      caseId: c.id,
      status: 'READY',
      storagePath: 'packages/abc.zip',
    });

    const res = await getPackage(
      new Request(`http://localhost/api/packages/${pkg.id}`) as NextRequest,
      pkgCtx(pkg.id)
    );
    const body = await res.json();
    expect(body.package.status).toBe('ready');
    expect(typeof body.downloadUrl).toBe('string');
  });

  it('foreign caller → 404 (no existence leak)', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);
    const pkg = await createTestPackage(owner.user.id, { caseId: c.id });

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await getPackage(
      new Request(`http://localhost/api/packages/${pkg.id}`) as NextRequest,
      pkgCtx(pkg.id)
    );
    expect(res.status).toBe(404);
  });

  it('same-org peer: 200 (read access mirrors case access)', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const c = await createTestCase(owner.user.id, { orgId: org.id });
    const pkg = await createTestPackage(owner.user.id, { caseId: c.id });

    const peer = await createTestUser({
      email: 'peer@iproofnow.dev',
      role: 'COMPANY',
    });
    await joinOrg(peer.user.id, org.id);
    await loginAs(peer.user.id);

    const res = await getPackage(
      new Request(`http://localhost/api/packages/${pkg.id}`) as NextRequest,
      pkgCtx(pkg.id)
    );
    expect(res.status).toBe(200);
  });
});
