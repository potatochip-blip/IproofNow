import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleAnchor } from '@/lib/jobs/anchor';
import { computeProofDigest, ProofDigestNotReadyError } from '@/lib/ots/proof-digest';
import { writeAudit } from '@/lib/audit';
import {
  createTestAnchor,
  createTestProof,
  createTestProofFile,
  createTestUser,
  db,
  truncateAll,
} from './helpers';
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
  stub.setMode('pending');
});

afterEach(() => {
  stub.digestSubmissions.length = 0;
});

const ctx = { jobId: 'test-job', attempts: 1 };

describe('computeProofDigest', () => {
  it('is deterministic across calls for the same proof', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id);
    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.created',
    });

    const a = await computeProofDigest(proof.id);
    const b = await computeProofDigest(proof.id);
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('changes when an audit row is added to the proof', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id);

    const before = await computeProofDigest(proof.id);
    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.sealed',
    });
    const after = await computeProofDigest(proof.id);
    expect(before.equals(after)).toBe(false);
  });

  it('throws ProofDigestNotReadyError while a file hash is PENDING', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id, { hashStatus: 'PENDING', fileHash: null });

    await expect(computeProofDigest(proof.id)).rejects.toBeInstanceOf(
      ProofDigestNotReadyError
    );
  });

  it('throws a plain Error when a file hash is FAILED', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id, { hashStatus: 'FAILED', fileHash: null });

    await expect(computeProofDigest(proof.id)).rejects.toThrow(/FAILED/);
    await expect(computeProofDigest(proof.id)).rejects.not.toBeInstanceOf(
      ProofDigestNotReadyError
    );
  });
});

describe('proof.anchor submit handler', () => {
  it('submits the digest and writes a PENDING anchor + upgrade job', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id);

    await handleAnchor({ proofId: proof.id }, ctx);

    const anchor = await db().proofAnchor.findUnique({ where: { proofId: proof.id } });
    expect(anchor).not.toBeNull();
    expect(anchor?.status).toBe('PENDING');
    expect(anchor?.contentHash).not.toBeNull();
    expect(anchor?.otsProof.length).toBeGreaterThan(0);
    expect(anchor?.bitcoinBlockHeight).toBeNull();

    // The digest reached the calendar.
    expect(stub.digestSubmissions).toHaveLength(1);
    expect(stub.digestSubmissions[0]).toHaveLength(32);

    // First upgrade poll is scheduled ~1h out.
    const upgradeJobs = await db().job.findMany({
      where: { type: 'proof.anchor.upgrade' },
    });
    expect(upgradeJobs).toHaveLength(1);
    const payload = upgradeJobs[0]?.payload as { proofId: string; attempt: number };
    expect(payload.proofId).toBe(proof.id);
    expect(payload.attempt).toBe(1);
    const delayMs = (upgradeJobs[0]!.runAfter.getTime()) - Date.now();
    expect(delayMs).toBeGreaterThan(50 * 60 * 1000);
    expect(delayMs).toBeLessThan(70 * 60 * 1000);
  });

  it('re-enqueues itself (no anchor row) while file hashes are PENDING', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id, { hashStatus: 'PENDING', fileHash: null });

    await handleAnchor({ proofId: proof.id }, ctx);

    expect(
      await db().proofAnchor.findUnique({ where: { proofId: proof.id } })
    ).toBeNull();
    expect(stub.digestSubmissions).toHaveLength(0);

    const retry = await db().job.findMany({ where: { type: 'proof.anchor' } });
    expect(retry).toHaveLength(1);
    const payload = retry[0]?.payload as { digestWaitAttempt: number };
    expect(payload.digestWaitAttempt).toBe(1);
    const delayMs = retry[0]!.runAfter.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(30 * 1000);
    expect(delayMs).toBeLessThan(90 * 1000);
  });

  it('is idempotent — skips a proof already PENDING (no second upgrade job)', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id);
    await createTestAnchor(proof.id, { status: 'PENDING' });

    await handleAnchor({ proofId: proof.id }, ctx);

    expect(stub.digestSubmissions).toHaveLength(0);
    expect(
      await db().job.count({ where: { type: 'proof.anchor.upgrade' } })
    ).toBe(0);
  });

  it('re-anchors a proof whose previous attempt FAILED', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestProofFile(proof.id);
    await createTestAnchor(proof.id, { status: 'FAILED' });

    await handleAnchor({ proofId: proof.id }, ctx);

    const anchor = await db().proofAnchor.findUnique({ where: { proofId: proof.id } });
    expect(anchor?.status).toBe('PENDING');
    expect(stub.digestSubmissions).toHaveLength(1);
  });

  it('rejects an invalid payload', async () => {
    await expect(handleAnchor({ proofId: 123 }, ctx)).rejects.toThrow(
      /invalid payload/
    );
  });
});
