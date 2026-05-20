import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as anchorVerify } from '@/app/api/proofs/[proofId]/anchor/verify/route';
import {
  createTestAnchor,
  createTestProof,
  createTestUser,
  db,
  loginAs,
  truncateAll,
} from './helpers';
import { resetCookieJar } from './cookie-jar';
import { startOtsStub, type OtsStub } from './ots-stub';

let stub: OtsStub;
let prevCalendars: string | undefined;
let prevExplorer: string | undefined;

beforeAll(async () => {
  stub = await startOtsStub();
  prevCalendars = process.env.OTS_CALENDAR_URLS;
  prevExplorer = process.env.BITCOIN_EXPLORER_URL;
  process.env.OTS_CALENDAR_URLS = stub.url;
  process.env.BITCOIN_EXPLORER_URL = stub.url;
});

afterAll(async () => {
  await stub.close();
  process.env.OTS_CALENDAR_URLS = prevCalendars;
  process.env.BITCOIN_EXPLORER_URL = prevExplorer;
  await db().$disconnect();
});

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
  stub.setMode('pending');
});

function verifyReq(proofId: string) {
  return new Request(
    `http://localhost/api/proofs/${proofId}/anchor/verify`
  ) as NextRequest;
}

describe('GET /api/proofs/:proofId/anchor/verify', () => {
  it('reports a CONFIRMED anchor with Bitcoin block detail', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestAnchor(proof.id, { status: 'CONFIRMED', bitcoinBlockHeight: 810_000 });
    await loginAs(user.id);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.anchored).toBe(true);
    expect(body.status).toBe('CONFIRMED');
    expect(body.confirmed).toBe(true);
    expect(body.contentHashMatches).toBe(true);
    expect(body.bitcoin.height).toBe(810_000);
    expect(body.bitcoin.blockHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('live-upgrades a PENDING anchor when the calendar now confirms it', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestAnchor(proof.id, { status: 'PENDING' });
    await loginAs(user.id);
    stub.setMode('confirmed');
    stub.setBlockHeight(811_111);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    const body = await res.json();
    expect(body.anchored).toBe(true);
    expect(body.status).toBe('PENDING');
    expect(body.confirmed).toBe(true);
    expect(body.bitcoin.height).toBe(811_111);
  });

  it('reports confirmed=false for a PENDING anchor the calendar has not confirmed', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestAnchor(proof.id, { status: 'PENDING' });
    await loginAs(user.id);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    const body = await res.json();
    expect(body.confirmed).toBe(false);
    expect(body.bitcoin).toBeNull();
  });

  it('flags contentHashMatches=false when the receipt commits to a different digest', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    const realDigest = createHash('sha256').update('the-real-content').digest();
    const claimedDigest = createHash('sha256').update('a-different-content').digest();
    // otsProof attests to realDigest, but contentHash column claims another.
    await createTestAnchor(proof.id, {
      status: 'CONFIRMED',
      contentHash: claimedDigest,
      otsProof: undefined,
      bitcoinBlockHeight: 800_000,
    });
    // Overwrite otsProof so it commits to realDigest, not claimedDigest.
    const { buildStoredOtsProof } = await import('./ots-stub');
    await db().proofAnchor.update({
      where: { proofId: proof.id },
      data: { otsProof: buildStoredOtsProof(realDigest, { confirmed: true, height: 800_000 }) },
    });
    await loginAs(user.id);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    const body = await res.json();
    expect(body.contentHashMatches).toBe(false);
  });

  it('returns anchored=false when there is no anchor', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await loginAs(user.id);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    const body = await res.json();
    expect(body.anchored).toBe(false);
    expect(body.status).toBeNull();
  });

  it('returns anchored=false for a legacy STUB anchor', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestAnchor(proof.id, { status: 'STUB' });
    await loginAs(user.id);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    const body = await res.json();
    expect(body.anchored).toBe(false);
    expect(body.status).toBe('STUB');
  });

  it('404s a hidden-vault proof for a non-owner (no existence leak)', async () => {
    const { user: owner } = await createTestUser();
    const { user: other } = await createTestUser({ email: 'other@iproofnow.dev' });
    const proof = await createTestProof(owner.id);
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });
    await createTestAnchor(proof.id, { status: 'CONFIRMED' });
    await loginAs(other.id);

    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    expect(res.status).toBe(404);
  });

  it('401s without a session', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    const res = await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });
    expect(res.status).toBe(401);
  });

  it('audits proof.anchor.verified', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestAnchor(proof.id, { status: 'CONFIRMED' });
    await loginAs(user.id);

    await anchorVerify(verifyReq(proof.id), { params: { proofId: proof.id } });

    const audit = await db().auditLog.findFirst({
      where: { action: 'proof.anchor.verified', entityId: proof.id },
    });
    expect(audit).not.toBeNull();
    const meta = audit?.meta as { status: string; confirmed: boolean };
    expect(meta.status).toBe('CONFIRMED');
    expect(meta.confirmed).toBe(true);
  });
});
