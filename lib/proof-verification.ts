import type { VerificationResult, VerificationTier } from '@prisma/client';
import { prisma } from './db';
import { computeProofDigestCached } from './ots/proof-digest';

/**
 * Phase 8 — the real verification evaluator.
 *
 * Replaces the Phase 3 placeholder (every verify returned 'verified').
 * `evaluateProof` recomputes the proof's content digest and compares it to
 * the digest captured at anchor time (ProofAnchor.contentHash):
 *
 *   NOT_FOUND     — no anchor, or the anchor has no contentHash baseline
 *                   (a DRAFT proof, an unanchored sealed proof, or a legacy
 *                   STUB anchor). Nothing to verify against.
 *   INDETERMINATE — an anchor exists, but the current digest can't be
 *                   computed (a file hash is PENDING or FAILED). Transient
 *                   for a normally-anchored proof — caller should retry.
 *   VERIFIED      — recomputed digest matches the anchored digest.
 *   TAMPERED      — recomputed digest does NOT match — the proof's content
 *                   changed after it was anchored.
 *
 * Tier (only meaningful for VERIFIED, null otherwise):
 *   CRYPTOGRAPHICALLY_VERIFIED — the anchor is Bitcoin-CONFIRMED.
 *   HASH_VERIFIED              — anchored but not (yet) on Bitcoin
 *                                (PENDING or FAILED anchor).
 */

export type ProofVerification = {
  result: VerificationResult;
  tier: VerificationTier | null;
};

export async function evaluateProof(proof: {
  id: string;
  updatedAt: Date;
}): Promise<ProofVerification> {
  const anchor = await prisma.proofAnchor.findUnique({
    where: { proofId: proof.id },
    select: { status: true, contentHash: true },
  });

  // No anchored baseline to compare against.
  if (!anchor || anchor.contentHash === null) {
    return { result: 'NOT_FOUND', tier: null };
  }

  let digest: Buffer;
  try {
    digest = await computeProofDigestCached(proof);
  } catch {
    // ProofDigestNotReadyError (files PENDING) or a FAILED-hash Error —
    // either way the current digest is unknowable right now.
    return { result: 'INDETERMINATE', tier: null };
  }

  if (!digest.equals(Buffer.from(anchor.contentHash))) {
    return { result: 'TAMPERED', tier: null };
  }

  return {
    result: 'VERIFIED',
    tier: anchor.status === 'CONFIRMED' ? 'CRYPTOGRAPHICALLY_VERIFIED' : 'HASH_VERIFIED',
  };
}
