-- Phase 8: verification result enrichment — VerificationResult enum + tier.
--
-- Notes:
--   * VerificationRecord.result was a free String; Phase 3–7 only ever wrote
--     'verified'. The USING cast uppercases it to the enum — and aborts
--     loudly if any row holds a value outside the enum, so it self-gates.
--   * Adding `tier` (and folding it into the entryHash composition) is a
--     verification-chain format change. Every existing entryHash is now
--     stale; scripts/backfill-verification-result.ts re-stamps the chain.
--     verifyVerificationChain reports rows broken until that backfill runs.

-- ── Enums ────────────────────────────────────────────────────────────────
CREATE TYPE "VerificationResult" AS ENUM (
  'VERIFIED', 'TAMPERED', 'NOT_FOUND', 'INDETERMINATE'
);
CREATE TYPE "VerificationTier" AS ENUM (
  'HASH_VERIFIED', 'CRYPTOGRAPHICALLY_VERIFIED'
);

-- ── VerificationRecord.result: String → VerificationResult ───────────────
ALTER TABLE "VerificationRecord"
  ALTER COLUMN "result" TYPE "VerificationResult"
  USING (upper("result")::"VerificationResult");

-- ── VerificationRecord.tier (nullable — null for non-VERIFIED rows) ──────
ALTER TABLE "VerificationRecord" ADD COLUMN "tier" "VerificationTier";
