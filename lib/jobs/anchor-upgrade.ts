import { prisma } from '../db';
import { logger } from '../logger';
import { enqueueJob, TerminalJobError, type JobHandler } from '../jobs';
import { upgradeOts } from '../ots/client';
import { getBlockByHeight } from '../ots/bitcoin-explorer';

type UpgradePayload = { proofId: string; attempt: number };

function isUpgradePayload(p: unknown): p is UpgradePayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { proofId?: unknown }).proofId === 'string' &&
    typeof (p as { attempt?: unknown }).attempt === 'number'
  );
}

/**
 * Hours to wait AFTER attempt N before attempt N+1 (1-indexed: attempt 1
 * uses index 0). The submit handler already scheduled attempt 1 at +1h.
 * Cumulative from submit: 1 + 6 + 24×6 = 151h ≈ 6.3 days — attempt 8 is
 * the last poll, comfortably inside a 7-day ceiling. Running out of the
 * array is the terminal signal.
 */
const UPGRADE_BACKOFF_HOURS = [6, 24, 24, 24, 24, 24, 24];
const HOUR_MS = 60 * 60 * 1000;

/**
 * proof.anchor.upgrade — Phase 7 OpenTimestamps upgrade poll.
 *
 * Polls the calendars for a Bitcoin-confirmed receipt:
 *   - confirmed  → replace otsProof with the full receipt, flip CONFIRMED,
 *                  record the block height/hash, done.
 *   - not ready  → re-enqueue the next poll on the backoff schedule.
 *   - cap hit    → flip the anchor FAILED and raise TerminalJobError so the
 *                  runner records exactly one job.failed.
 *
 * "Not ready" is the expected steady state — a calendar 404 is swallowed by
 * the OTS library, never surfaced as an error. A genuine network/parse
 * failure throws normally and takes the runner's standard 3-attempt retry.
 *
 * OTS calendar round-trips are deliberately NOT audited: a single proof
 * generates ~8 polls over a week, and the ProofAnchor row + its status
 * transitions are already the source of truth. Only the user-initiated
 * proof.anchor.verified read is audited.
 */
export const handleAnchorUpgrade: JobHandler = async (payload) => {
  if (!isUpgradePayload(payload)) {
    throw new Error(
      'anchor.upgrade: invalid payload (expected { proofId: string, attempt: number })'
    );
  }
  const { proofId, attempt } = payload;

  const anchor = await prisma.proofAnchor.findUnique({ where: { proofId } });
  if (!anchor) {
    logger.warn('anchor.upgrade.missing', { proofId });
    return;
  }
  if (anchor.status === 'CONFIRMED' || anchor.status === 'FAILED') {
    logger.info('anchor.upgrade.skip', { proofId, status: anchor.status });
    return;
  }

  const result = await upgradeOts(Buffer.from(anchor.otsProof));

  if (result.confirmed && result.bitcoin) {
    const block = await getBlockByHeight(result.bitcoin.height);
    const now = new Date();
    await prisma.proofAnchor.update({
      where: { proofId },
      data: {
        otsProof: result.otsProof,
        status: 'CONFIRMED',
        bitcoinBlockHeight: result.bitcoin.height,
        bitcoinBlockHash: block?.blockHash ?? null,
        confirmedAt: now,
        upgradedAt: now,
      },
    });
    logger.info('anchor.upgrade.confirmed', {
      proofId,
      height: result.bitcoin.height,
      attempt,
    });
    return;
  }

  const nextDelayHours = UPGRADE_BACKOFF_HOURS[attempt - 1];
  if (nextDelayHours === undefined) {
    await prisma.proofAnchor.update({
      where: { proofId },
      data: { status: 'FAILED' },
    });
    throw new TerminalJobError(
      `anchor.upgrade: proof ${proofId} not confirmed after ${attempt} attempts (~7 days)`
    );
  }

  await enqueueJob(
    'proof.anchor.upgrade',
    { proofId, attempt: attempt + 1 },
    { runAfter: new Date(Date.now() + nextDelayHours * HOUR_MS) }
  );
  logger.info('anchor.upgrade.pending', {
    proofId,
    attempt,
    nextAttemptInHours: nextDelayHours,
  });
};
