import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST as uploadFile } from '@/app/api/proofs/[proofId]/files/route';
import { POST as requestPackage } from '@/app/api/cases/[caseId]/packages/route';
import { GET as verifyPackage } from '@/app/api/packages/[packageId]/verify/route';
import { drainJobs } from '@/lib/jobs';
import { isStorageReachable, getPresignedGetUrl, putObject } from '@/lib/storage';
import { verifyPackageBytes } from '@/lib/package-sig';
import {
  buildJsonRequest,
  buildMultipartRequest,
  createTestCase,
  createTestProof,
  createTestUser,
  db,
  linkCaseProof,
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

describe('evidence_package.build worker (MinIO-gated)', () => {
  it('builds the zip end-to-end: status=READY, downloadable, contains manifest + files', async (t) => {
    if (!(await isStorageReachable())) {
      t.skip();
      return;
    }
    const { user } = await createTestUser();
    await loginAs(user.id);

    // Two proofs, each with a file. Link both to the case.
    const proof1 = await createTestProof(user.id, { title: 'Proof Alpha' });
    const proof2 = await createTestProof(user.id, { title: 'Proof Bravo' });

    for (const p of [proof1, proof2]) {
      const bytes = new TextEncoder().encode(`bytes-for-${p.id}`);
      const upRes = await uploadFile(
        buildMultipartRequest(
          `http://localhost/api/proofs/${p.id}/files`,
          bytes,
          'evidence.txt',
          'text/plain'
        ) as NextRequest,
        { params: { proofId: p.id } }
      );
      expect(upRes.status).toBe(201);
    }

    const c = await createTestCase(user.id, { title: 'Case Zeta' });
    await linkCaseProof(c.id, proof1.id);
    await linkCaseProof(c.id, proof2.id);

    // Drain hash jobs first so files have known sha256s in the manifest.
    await drainJobs();

    // Request a package — this writes EvidencePackage(PENDING) and enqueues
    // evidence_package.build atomically.
    const reqRes = await requestPackage(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/packages`,
        'POST',
        { packageType: 'court_bundle' }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(reqRes.status).toBe(202);
    const reqBody = await reqRes.json();
    const packageId = reqBody.packageId as string;

    // Drain — should find the build job and complete it.
    const ran = await drainJobs();
    expect(ran).toBeGreaterThan(0);

    const pkg = await db().evidencePackage.findUnique({ where: { id: packageId } });
    expect(pkg?.status).toBe('READY');
    expect(pkg?.storagePath).toBe(`packages/${packageId}.zip`);

    // Notification fired to case owner.
    const notif = await db().notification.findFirst({
      where: { userId: user.id, type: 'evidence_package_ready' },
    });
    expect(notif).toBeTruthy();
    expect(notif?.href).toBe(`/cases/${c.id}`);

    // Fetch the zip via the presigned URL and confirm it's a non-empty zip.
    const url = await getPresignedGetUrl(pkg!.storagePath!);
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    const ab = await fetched.arrayBuffer();
    const buf = Buffer.from(ab);
    expect(buf.length).toBeGreaterThan(50);
    // Zip files start with the local file header signature 'PK\x03\x04'.
    expect(buf.slice(0, 4).toString('hex')).toBe('504b0304');

    // Phase 9: the built package is signed.
    expect(pkg?.signature).toBeTruthy();
    expect(pkg?.contentHash).toBeTruthy();
    expect(pkg?.signingKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(pkg?.signedAt).toBeTruthy();

    // The detached .sig sidecar lets an offline verifier accept the bundle.
    const sigRes = await fetch(await getPresignedGetUrl(`${pkg!.storagePath}.sig`));
    expect(sigRes.status).toBe(200);
    const sig = await sigRes.json();
    expect(verifyPackageBytes(buf, sig).ok).toBe(true);

    // The verify endpoint agrees.
    const okRes = await verifyPackage(
      new Request(`http://localhost/api/packages/${packageId}/verify`) as NextRequest,
      { params: { packageId } }
    );
    expect(await okRes.json()).toMatchObject({
      signed: true,
      signatureValid: true,
      digestMatches: true,
    });

    // Tamper the stored zip — digestMatches must flip to false.
    await putObject(pkg!.storagePath!, Buffer.from('not a zip anymore'), 'application/zip');
    const tamperedRes = await verifyPackage(
      new Request(`http://localhost/api/packages/${packageId}/verify`) as NextRequest,
      { params: { packageId } }
    );
    const tampered = await tamperedRes.json();
    expect(tampered.signed).toBe(true);
    expect(tampered.signatureValid).toBe(true);
    expect(tampered.digestMatches).toBe(false);
  });

  it('owner-self request still notifies owner (mirrors proof_sealed self-notify)', async (t) => {
    if (!(await isStorageReachable())) {
      t.skip();
      return;
    }
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);

    const reqRes = await requestPackage(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/packages`,
        'POST',
        { packageType: 'custom' }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(reqRes.status).toBe(202);

    await drainJobs();

    const ready = await db().notification.findFirst({
      where: { userId: user.id, type: 'evidence_package_ready' },
    });
    expect(ready).toBeTruthy();
  });

  it('missing case (deleted between enqueue and run): package stays PENDING, job fails terminal', async () => {
    // Create a job pointing at a packageId that doesn't exist — handler
    // logs a warn and returns (terminal no-op), so the row never appears
    // and no notification is sent.
    await db().job.create({
      data: {
        type: 'evidence_package.build',
        payload: { packageId: 'nope' },
      },
    });

    const ran = await drainJobs();
    expect(ran).toBe(1);
    const job = await db().job.findFirst({
      where: { type: 'evidence_package.build' },
    });
    expect(job?.status).toBe('COMPLETE');

    const ready = await db().notification.findMany({
      where: { type: 'evidence_package_ready' },
    });
    expect(ready).toEqual([]);
  });
});
