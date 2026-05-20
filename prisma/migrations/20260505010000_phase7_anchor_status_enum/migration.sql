-- Phase 7: ProofAnchor lifecycle — status enum + Bitcoin attestation fields.
--
-- Notes:
--   * ProofAnchor.status was a free String defaulting to 'STUB'. The only
--     value ever written by Phase 5 is 'STUB', so the USING cast below is
--     total. scripts/backfill-anchor-status.ts is the documented gate:
--     run it first to assert no row holds a value outside the enum.
--   * contentHash is nullable — legacy STUB rows never had one; every
--     PENDING/CONFIRMED row written by Phase 7 populates it.

-- ── AnchorStatus enum ────────────────────────────────────────────────────
CREATE TYPE "AnchorStatus" AS ENUM ('STUB', 'PENDING', 'CONFIRMED', 'FAILED');

-- ── ProofAnchor.status: String → AnchorStatus ────────────────────────────
-- Drop the old text default before the type swap, re-add it as the enum.
ALTER TABLE "ProofAnchor" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ProofAnchor"
  ALTER COLUMN "status" TYPE "AnchorStatus"
  USING ("status"::"AnchorStatus");
ALTER TABLE "ProofAnchor" ALTER COLUMN "status" SET DEFAULT 'STUB';

-- ── New columns ──────────────────────────────────────────────────────────
ALTER TABLE "ProofAnchor"
  ADD COLUMN "contentHash"        BYTEA,
  ADD COLUMN "bitcoinBlockHeight" INTEGER,
  ADD COLUMN "bitcoinBlockHash"   TEXT,
  ADD COLUMN "confirmedAt"        TIMESTAMP(3),
  ADD COLUMN "upgradedAt"         TIMESTAMP(3);
