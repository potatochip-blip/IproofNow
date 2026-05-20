import { prisma } from '../db';
import { logger } from '../logger';
import { enqueueJob, TerminalJobError, type JobHandler } from '../jobs';
import { computeProofDigest, ProofDigestNotReadyError } from '../ots/proof-digest';
import { submitDigest } from '../ots/client';

type AnchorPayload = { proofId: string; digestWaitAttempt?: number };

function isAnchorPayload(p: unknown): p is AnchorPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { proofId?: unknown }).proofId === 'string'
  );
}

/** Delay between digest-readiness retries while files are still hashing. */
const DIGEST_WAIT_MS = 60_000;
/** Cap on digest-readiness retries — 15 × 60s = 15 min for hashing to finish. */
const MAX_DIGEST_WAITS = 15;
/** Gap from a successful submit to the first upgrade poll. */
const FIRST_UPGRADE_DELAY_MS = 60 * 60 * 1000; // +1h

/**
 * proof.anchor — Phase 7 OpenTimestamps submit handler.
 *
 * 1. Compute the proof's content digest (chained audit entries + file
 *    hashes + attestation). If files are still hashing, re-enqueue with a
 *    delay rather than burning the runner's retry budget; give up (terminal)
 *    after MAX_DIGEST_WAITS.
 * 2. Submit the digest to the OTS calendars. The partial proof is stored
 *    with status=PENDING and contentHash recorded.
 * 3. Enqueue the first proof.anchor.upgrade poll at +1h, atomically with
 *    the anchor row so a PENDING anchor always has an upgrade job behind it.
 *
 * Idempotency: an anchor already PENDING or CONFIRMED is left untouched
 * (re-running must not reset a confirmed receipt or double-enqueue the
 * upgrade chain). A legacy STUB row or a prior FAILED row is re-anchored.
 */
export const handleAnchor: JobHandler = async (payload) => {
  if (!isAnchorPayload(payload)) {
    throw new Error('anchor: invalid payload (expected { proofId: string })');
  }
  const { proofId } = payload;
  const digestWaitAttempt = payload.digestWaitAttempt ?? 0;

  const proof = await prisma.proof.findUnique({ where: { id: proofId } });
  if (!proof) {
    logger.warn('anchor.missing', { proofId });
    return;
  }

  const existing = await prisma.proofAnchor.findUnique({ where: { proofId } });
  if (existing && (existing.status === 'PENDING' || existing.status === 'CONFIRMED')) {
    logger.info('anchor.skip', { proofId, status: existing.status });
    return;
  }

  let digest: Buffer;
  try {
    digest = await computeProofDigest(proofId);
  } catch (err) {
    if (err instanceof ProofDigestNotReadyError) {
      if (digestWaitAttempt >= MAX_DIGEST_WAITS) {
        throw new TerminalJobError(
          `anchor: file hashes not ready after ${MAX_DIGEST_WAITS} waits for proof ${proofId}`
        );
      }
      await enqueueJob(
        'proof.anchor',
        { proofId, digestWaitAttempt: digestWaitAttempt + 1 },
        { runAfter: new Date(Date.now() + DIGEST_WAIT_MS) }
      );
      logger.info('anchor.digest_wait', { proofId, attempt: digestWaitAttempt + 1 });
      return;
    }
    throw err;
  }

  const { otsProof, calendarsAccepted } = await submitDigest(digest);
  logger.info('anchor.submitted', { proofId, calendars: calendarsAccepted });

  await prisma.$transaction(async (tx) => {
    await tx.proofAnchor.upsert({
      where: { proofId },
      create: {
        proofId,
        contentHash: digest,
        otsProof,
        status: 'PENDING',
      },
      update: {
        contentHash: digest,
        otsProof,
        status: 'PENDING',
        anchoredAt: new Date(),
        bitcoinBlockHeight: null,
        bitcoinBlockHash: null,
        confirmedAt: null,
        upgradedAt: null,
      },
    });

    await enqueueJob(
      'proof.anchor.upgrade',
      { proofId, attempt: 1 },
      { runAfter: new Date(Date.now() + FIRST_UPGRADE_DELAY_MS), tx }
    );
  });
};
