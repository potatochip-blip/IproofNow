import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendVerificationRecord,
  computeVerificationEntryHash,
  verifyVerificationChain,
} from '@/lib/verification-chain';
import { createTestProof, createTestUser, db, truncateAll } from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

describe('verification record per-proof hash chain', () => {
  it('empty chain verifies ok with count=0', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    const result = await verifyVerificationChain(proof.id);
    expect(result).toEqual({ ok: true, count: 0 });
  });

  it('genesis row has prevHash null and chain links forward', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);

    for (let i = 0; i < 4; i++) {
      await appendVerificationRecord({
        proofId: proof.id,
        method: 'hash',
        result: 'verified',
      });
    }

    const rows = await db().verificationRecord.findMany({
      where: { proofId: proof.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(4);
    expect(rows[0]?.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.prevHash).toBe(rows[i - 1]?.entryHash);
    }

    const result = await verifyVerificationChain(proof.id);
    expect(result).toEqual({ ok: true, count: 4 });
  });

  it('chains are isolated per proofId', async () => {
    const { user } = await createTestUser();
    const proofA = await createTestProof(user.id, { title: 'A' });
    const proofB = await createTestProof(user.id, { title: 'B' });

    await appendVerificationRecord({ proofId: proofA.id, method: 'hash', result: 'verified' });
    await appendVerificationRecord({ proofId: proofB.id, method: 'hash', result: 'verified' });
    await appendVerificationRecord({ proofId: proofA.id, method: 'qr', result: 'verified' });

    const aRows = await db().verificationRecord.findMany({
      where: { proofId: proofA.id },
      orderBy: { createdAt: 'asc' },
    });
    const bRows = await db().verificationRecord.findMany({
      where: { proofId: proofB.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(aRows).toHaveLength(2);
    expect(bRows).toHaveLength(1);

    // proofA's second row chains to proofA's first — NOT to proofB's row.
    expect(aRows[1]?.prevHash).toBe(aRows[0]?.entryHash);
    expect(aRows[1]?.prevHash).not.toBe(bRows[0]?.entryHash);

    // Each chain verifies independently.
    expect(await verifyVerificationChain(proofA.id)).toEqual({ ok: true, count: 2 });
    expect(await verifyVerificationChain(proofB.id)).toEqual({ ok: true, count: 1 });
  });

  it('detects tampered method as hash_mismatch', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    const r1 = await appendVerificationRecord({ proofId: proof.id, method: 'hash', result: 'verified' });
    await appendVerificationRecord({ proofId: proof.id, method: 'qr', result: 'verified' });

    await db().$executeRawUnsafe(
      `UPDATE "VerificationRecord" SET "method" = 'link' WHERE "id" = $1`,
      r1.id
    );

    const result = await verifyVerificationChain(proof.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(r1.id);
      expect(result.reason).toBe('hash_mismatch');
    }
  });

  it('per-proof cursor row mirrors the chain head', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    const r1 = await appendVerificationRecord({ proofId: proof.id, method: 'hash', result: 'verified' });

    const cursor1 = await db().verificationChainCursor.findUnique({
      where: { proofId: proof.id },
    });
    expect(cursor1?.lastEntryHash).toBe(r1.entryHash);

    const r2 = await appendVerificationRecord({ proofId: proof.id, method: 'qr', result: 'verified' });
    const cursor2 = await db().verificationChainCursor.findUnique({
      where: { proofId: proof.id },
    });
    expect(cursor2?.lastEntryHash).toBe(r2.entryHash);
  });

  it('computeVerificationEntryHash is deterministic', () => {
    const t = new Date('2026-05-05T12:00:00.000Z');
    const a = computeVerificationEntryHash({
      prevHash: null,
      proofId: 'p1',
      method: 'hash',
      result: 'verified',
      requesterContext: { ip: '203.0.113.5' },
      createdAt: t,
    });
    const b = computeVerificationEntryHash({
      prevHash: null,
      proofId: 'p1',
      method: 'hash',
      result: 'verified',
      requesterContext: { ip: '203.0.113.5' },
      createdAt: t,
    });
    expect(a).toBe(b);
  });
});
