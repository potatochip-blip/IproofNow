import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST as verify } from '@/app/api/proofs/[proofId]/verify/route';
import { evaluateProof } from '@/lib/proof-verification';
import { computeProofDigest, clearProofDigestCache } from '@/lib/ots/proof-digest';
import {
  buildJsonRequest,
  createTestAnchor,
  createTestProof,
  createTestProofFile,
  createTestUser,
  db,
  truncateAll,
} from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
  clearProofDigestCache();
});

afterAll(async () => {
  await db().$disconnect();
});

/** Create a proof + one COMPLETE file, anchored with contentHash = its real digest. */
async function anchoredProof(
  status: 'PENDING' | 'CONFIRMED' | 'FAILED'
): Promise<{ proof: Awaited<ReturnType<typeof createTestProof>>; fileId: string }> {
  const { user } = await createTestUser();
  const proof = await createTestProof(user.id);
  const file = await createTestProofFile(proof.id);
  const digest = await computeProofDigest(proof.id);
  await createTestAnchor(proof.id, { status, contentHash: digest });
  return { proof, fileId: file.id };
}

describe('evaluateProof — result taxonomy', () => {
  it('NOT_FOUND when the proof has no anchor', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    expect(await evaluateProof(proof)).toEqual({ result: 'NOT_FOUND', tier: null });
  });

  it('NOT_FOUND for a legacy STUB anchor (no contentHash baseline)', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await db().proofAnchor.create({
      data: { proofId: proof.id, status: 'STUB', otsProof: Buffer.from('legacy') },
    });
    expect(await evaluateProof(proof)).toEqual({ result: 'NOT_FOUND', tier: null });
  });

  it('VERIFIED + HASH_VERIFIED for an intact PENDING-anchored proof', async () => {
    const { proof } = await anchoredProof('PENDING');
    expect(await evaluateProof(proof)).toEqual({
      result: 'VERIFIED',
      tier: 'HASH_VERIFIED',
    });
  });

  it('VERIFIED + CRYPTOGRAPHICALLY_VERIFIED for an intact CONFIRMED-anchored proof', async () => {
    const { proof } = await anchoredProof('CONFIRMED');
    expect(await evaluateProof(proof)).toEqual({
      result: 'VERIFIED',
      tier: 'CRYPTOGRAPHICALLY_VERIFIED',
    });
  });

  it('VERIFIED + HASH_VERIFIED for a FAILED anchor (content matches, never hit Bitcoin)', async () => {
    const { proof } = await anchoredProof('FAILED');
    expect(await evaluateProof(proof)).toEqual({
      result: 'VERIFIED',
      tier: 'HASH_VERIFIED',
    });
  });

  it('TAMPERED when a file hash changes after anchoring', async () => {
    const { proof, fileId } = await anchoredProof('CONFIRMED');
    // Mutate the proof's content — the anchored contentHash no longer matches.
    await db().proofFile.update({
      where: { id: fileId },
      data: { fileHash: 'a'.repeat(64) },
    });
    clearProofDigestCache();
    expect(await evaluateProof(proof)).toEqual({ result: 'TAMPERED', tier: null });
  });

  it('INDETERMINATE when a file hash is still PENDING (digest uncomputable)', async () => {
    const { proof } = await anchoredProof('PENDING');
    // A newly-added file still hashing makes the current digest unknowable.
    await createTestProofFile(proof.id, { hashStatus: 'PENDING', fileHash: null });
    clearProofDigestCache();
    expect(await evaluateProof(proof)).toEqual({ result: 'INDETERMINATE', tier: null });
  });

  it('INDETERMINATE when a file hash FAILED', async () => {
    const { proof } = await anchoredProof('PENDING');
    await createTestProofFile(proof.id, { hashStatus: 'FAILED', fileHash: null });
    clearProofDigestCache();
    expect(await evaluateProof(proof)).toEqual({ result: 'INDETERMINATE', tier: null });
  });
});

describe('POST /verify — end-to-end real results', () => {
  function verifyReq(proofId: string) {
    return buildJsonRequest(
      `http://localhost/api/proofs/${proofId}/verify`,
      'POST',
      { method: 'hash' }
    ) as NextRequest;
  }

  it('intact CONFIRMED-anchored PUBLIC proof → VERIFIED / CRYPTOGRAPHICALLY_VERIFIED', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id, { visibility: 'PUBLIC' });
    await createTestProofFile(proof.id);
    const digest = await computeProofDigest(proof.id);
    await createTestAnchor(proof.id, { status: 'CONFIRMED', contentHash: digest });
    clearProofDigestCache();

    const res = await verify(verifyReq(proof.id), { params: { proofId: proof.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe('VERIFIED');
    expect(body.tier).toBe('CRYPTOGRAPHICALLY_VERIFIED');

    const rec = await db().verificationRecord.findUniqueOrThrow({
      where: { id: body.verificationId },
    });
    expect(rec.result).toBe('VERIFIED');
    expect(rec.tier).toBe('CRYPTOGRAPHICALLY_VERIFIED');
  });

  it('tampered proof → TAMPERED, audited even for an anonymous PUBLIC verify', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id, { visibility: 'PUBLIC' });
    const file = await createTestProofFile(proof.id);
    const digest = await computeProofDigest(proof.id);
    await createTestAnchor(proof.id, { status: 'CONFIRMED', contentHash: digest });
    await db().proofFile.update({
      where: { id: file.id },
      data: { fileHash: 'b'.repeat(64) },
    });
    clearProofDigestCache();

    // Anonymous caller — no loginAs.
    const res = await verify(verifyReq(proof.id), { params: { proofId: proof.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe('TAMPERED');
    expect(body.tier).toBeNull();

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.verified' },
      orderBy: { createdAt: 'desc' },
    });
    const meta = audit?.meta as { result: string; tier: string | null; anonymous: boolean };
    expect(meta.result).toBe('TAMPERED');
    expect(meta.tier).toBeNull();
    expect(meta.anonymous).toBe(true);
  });
});
