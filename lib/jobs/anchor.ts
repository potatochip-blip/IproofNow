import { createHash } from 'node:crypto';
import { prisma } from '../db';
import { logger } from '../logger';
import type { JobHandler } from '../jobs';

type AnchorPayload = { proofId: string };

function isAnchorPayload(p: unknown): p is AnchorPayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { proofId?: unknown }).proofId === 'string'
  );
}

/**
 * proof.anchor — Phase 5 stub for the OpenTimestamps integration.
 *
 * Writes a deterministic pseudo-OTS proof so the frontend has something
 * non-empty to render against ("anchored: stub" badge). Phase 7 will
 * replace this with real OTS submission + receipt handling, at which
 * point the otsProof bytes become the actual `.ots` receipt and status
 * flips through STUB → CONFIRMED as the calendar servers acknowledge.
 *
 * Idempotent — proofId has a unique constraint so re-runs upsert.
 *
 * Why deterministic bytes (sha256 of the proof id) instead of empty
 * placeholder: Phase 7 tests can assert "stub anchors are exactly
 * sha256(proofId)" before swapping in real OTS, surfacing any code
 * paths that read the bytes for content rather than just presence.
 */
export const handleAnchor: JobHandler = async (payload) => {
  if (!isAnchorPayload(payload)) {
    throw new Error('anchor: invalid payload (expected { proofId: string })');
  }
  const { proofId } = payload;

  const proof = await prisma.proof.findUnique({ where: { id: proofId } });
  if (!proof) {
    logger.warn('anchor.missing', { proofId });
    return;
  }

  const otsProof = createHash('sha256').update(proofId).digest();

  await prisma.proofAnchor.upsert({
    where: { proofId },
    create: { proofId, otsProof, status: 'STUB' },
    update: { otsProof, status: 'STUB', anchoredAt: new Date() },
  });
};
