-- Phase 9: evidence package signing — detached ed25519 signature columns.
--
-- All four columns are nullable: legacy READY packages built before Phase 9
-- have no signature and the verify endpoint reports them `signed:false`.
-- No data transformation / gate script is needed (unlike the Phase 7 enum
-- cast or Phase 8 chain re-stamp) — these are pure additive columns.
-- scripts/backfill-package-signatures.ts can optionally re-sign legacy
-- packages after the fact, but is not required for the migration to apply.

ALTER TABLE "EvidencePackage"
  ADD COLUMN "contentHash"  BYTEA,
  ADD COLUMN "signature"    TEXT,
  ADD COLUMN "signingKeyId" TEXT,
  ADD COLUMN "signedAt"     TIMESTAMP(3);
