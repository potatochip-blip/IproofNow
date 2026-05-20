import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST as verify } from '@/app/api/proofs/[proofId]/verify/route';
import { GET as listVerifications } from '@/app/api/proofs/[proofId]/verifications/route';
import {
  buildJsonRequest,
  createTestOrg,
  createTestProof,
  createTestUser,
  createTestVerification,
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

function ctx(proofId: string) {
  return { params: { proofId } };
}

function verifyReq(proofId: string, body: unknown) {
  return buildJsonRequest(
    `http://localhost/api/proofs/${proofId}/verify`,
    'POST',
    body
  ) as NextRequest;
}

describe('POST /api/proofs/[proofId]/verify', () => {
  it('PUBLIC proof without session → 200, creates record + audit', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PUBLIC' });

    // Note: no loginAs — anonymous caller.
    const res = await verify(verifyReq(proof.id, { method: 'hash' }), ctx(proof.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proofId).toBe(proof.id);
    // Unanchored proof → no baseline to compare against.
    expect(body.result).toBe('NOT_FOUND');
    expect(body.tier).toBeNull();
    expect(body.verificationId).toBeTruthy();

    const rec = await db().verificationRecord.findUnique({
      where: { id: body.verificationId },
    });
    expect(rec?.method).toBe('hash');

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.verified' },
    });
    expect(audit?.actorUserId).toBeNull();
  });

  it('PRIVATE proof without session → 401', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PRIVATE' });

    const res = await verify(verifyReq(proof.id, { method: 'hash' }), ctx(proof.id));
    expect(res.status).toBe(401);
  });

  it('PRIVATE proof with owner session → 200', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id, { visibility: 'PRIVATE' });

    const res = await verify(verifyReq(proof.id, { method: 'qr' }), ctx(proof.id));
    expect(res.status).toBe(200);
  });

  it('ORG proof with org-mate session → 200', async () => {
    const ownerRes = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(ownerRes.user.id);
    await joinOrg(ownerRes.user.id, org.id);
    const proof = await createTestProof(ownerRes.user.id, {
      orgId: org.id,
      visibility: 'ORG',
    });

    const mateRes = await createTestUser({ email: 'mate@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(mateRes.user.id, org.id);
    await loginAs(mateRes.user.id);

    const res = await verify(verifyReq(proof.id, { method: 'link' }), ctx(proof.id));
    expect(res.status).toBe(200);
  });

  it('hidden proof → 404 for non-owner regardless of visibility', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PUBLIC' });
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    // Anonymous — should still 404, not 200 via PUBLIC path.
    const res = await verify(verifyReq(proof.id, { method: 'hash' }), ctx(proof.id));
    expect(res.status).toBe(404);
  });

  it('rejects invalid method', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PUBLIC' });

    const res = await verify(
      verifyReq(proof.id, { method: 'telepathy' }),
      ctx(proof.id)
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/proofs/[proofId]/verifications', () => {
  it('owner sees history + counts', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id);

    await createTestVerification(proof.id, {
      result: 'VERIFIED',
      tier: 'CRYPTOGRAPHICALLY_VERIFIED',
    });
    await createTestVerification(proof.id, {
      result: 'VERIFIED',
      tier: 'HASH_VERIFIED',
    });
    await createTestVerification(proof.id, { result: 'NOT_FOUND' });

    const res = await listVerifications(
      new Request(`http://localhost/api/proofs/${proof.id}/verifications`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifications).toHaveLength(3);
    expect(body.counts).toEqual({
      verified: 2,
      tampered: 0,
      notFound: 1,
      indeterminate: 0,
    });
    expect(body.tiers).toEqual({ hashVerified: 1, cryptographicallyVerified: 1 });
    expect(body.pagination.total).toBe(3);
  });

  it('PUBLIC proof: no session → 200', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PUBLIC' });
    await createTestVerification(proof.id);

    const res = await listVerifications(
      new Request(`http://localhost/api/proofs/${proof.id}/verifications`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(200);
  });

  it('PRIVATE proof: no session → 401', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PRIVATE' });

    const res = await listVerifications(
      new Request(`http://localhost/api/proofs/${proof.id}/verifications`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(401);
  });

  it('hidden proof: non-owner → 404', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PUBLIC' });
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    const res = await listVerifications(
      new Request(`http://localhost/api/proofs/${proof.id}/verifications`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(404);
  });
});
