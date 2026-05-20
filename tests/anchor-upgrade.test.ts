import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleAnchorUpgrade } from '@/lib/jobs/anchor-upgrade';
import { enqueueJob, runDueJobs, TerminalJobError } from '@/lib/jobs';
import {
  createTestAnchor,
  createTestProof,
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
  stub.setBlockHeight(800_000);
});

const ctx = { jobId: 'test-job', attempts: 1 };

async function pendingAnchor() {
  const { user } = await createTestUser();
  const proof = await createTestProof(user.id);
  await createTestAnchor(proof.id, { status: 'PENDING' });
  return proof;
}

describe('proof.anchor.upgrade handler', () => {
  it('confirms a PENDING anchor when the calendar returns a Bitcoin attestation', async () => {
    const proof = await pendingAnchor();
    stub.setMode('confirmed');
    stub.setBlockHeight(815_432);

    await handleAnchorUpgrade({ proofId: proof.id, attempt: 1 }, ctx);

    const anchor = await db().proofAnchor.findUnique({ where: { proofId: proof.id } });
    expect(anchor?.status).toBe('CONFIRMED');
    expect(anchor?.bitcoinBlockHeight).toBe(815_432);
    expect(anchor?.bitcoinBlockHash).not.toBeNull();
    expect(anchor?.confirmedAt).not.toBeNull();
    expect(anchor?.upgradedAt).not.toBeNull();

    // No further poll scheduled once confirmed.
    expect(await db().job.count({ where: { type: 'proof.anchor.upgrade' } })).toBe(0);
  });

  it('re-enqueues the next poll on the backoff schedule when not yet confirmed', async () => {
    const proof = await pendingAnchor();
    // stub stays in 'pending' mode → calendar 404s.

    await handleAnchorUpgrade({ proofId: proof.id, attempt: 1 }, ctx);

    const anchor = await db().proofAnchor.findUnique({ where: { proofId: proof.id } });
    expect(anchor?.status).toBe('PENDING');

    const next = await db().job.findMany({ where: { type: 'proof.anchor.upgrade' } });
    expect(next).toHaveLength(1);
    const payload = next[0]?.payload as { attempt: number };
    expect(payload.attempt).toBe(2);
    // attempt 1 → +6h before attempt 2.
    const delayHours = (next[0]!.runAfter.getTime() - Date.now()) / 3_600_000;
    expect(delayHours).toBeGreaterThan(5.5);
    expect(delayHours).toBeLessThan(6.5);
  });

  it('fails terminally once the 7-day cap is exceeded', async () => {
    const proof = await pendingAnchor();

    // attempt 8 has no schedule entry left → terminal.
    await expect(
      handleAnchorUpgrade({ proofId: proof.id, attempt: 8 }, ctx)
    ).rejects.toBeInstanceOf(TerminalJobError);

    const anchor = await db().proofAnchor.findUnique({ where: { proofId: proof.id } });
    expect(anchor?.status).toBe('FAILED');
    // No further poll enqueued.
    expect(await db().job.count({ where: { type: 'proof.anchor.upgrade' } })).toBe(0);
  });

  it('terminal failure surfaces one job.failed audit through the runner', async () => {
    const proof = await pendingAnchor();
    await enqueueJob('proof.anchor.upgrade', { proofId: proof.id, attempt: 8 });

    const result = await runDueJobs();
    expect(result?.status).toBe('FAILED');

    const failedAudits = await db().auditLog.findMany({
      where: { entityType: 'Job', action: 'job.failed' },
    });
    expect(failedAudits).toHaveLength(1);
    const meta = failedAudits[0]?.meta as { type: string; attempts: number };
    expect(meta.type).toBe('proof.anchor.upgrade');
    // TerminalJobError short-circuits — failed on the first attempt, no retries.
    expect(meta.attempts).toBe(1);
  });

  it('is a no-op for an already CONFIRMED anchor', async () => {
    const { user } = await createTestUser();
    const proof = await createTestProof(user.id);
    await createTestAnchor(proof.id, { status: 'CONFIRMED' });
    stub.setMode('confirmed');

    const before = stub.upgradePolls();
    await handleAnchorUpgrade({ proofId: proof.id, attempt: 3 }, ctx);
    expect(stub.upgradePolls()).toBe(before);

    const anchor = await db().proofAnchor.findUnique({ where: { proofId: proof.id } });
    expect(anchor?.status).toBe('CONFIRMED');
  });

  it('is a no-op when the anchor row is missing', async () => {
    await expect(
      handleAnchorUpgrade({ proofId: 'no-such-proof', attempt: 1 }, ctx)
    ).resolves.toBeUndefined();
  });
});
