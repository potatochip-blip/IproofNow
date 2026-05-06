-- Phase 6: audit + verification hash chains, signing column, immutability trigger.
--
-- Notes:
--   * Columns ship as nullable / DEFAULT '' so the migration can apply on a
--     non-empty production AuditLog without an upfront backfill window. The
--     scripts/backfill-audit-chain.ts one-shot stamps existing rows; a
--     follow-up migration tightens entryHash to NOT NULL and drops the default.
--   * The BEFORE UPDATE trigger only blocks proof.hidden.revealed rows inside
--     a 24h window. Tests verify both inside-window block + outside-window
--     allow via raw SQL UPDATEs.

-- ── AuditLog: chain + signature columns ──────────────────────────────────
ALTER TABLE "AuditLog"
  ADD COLUMN "prevHash"  TEXT,
  ADD COLUMN "entryHash" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "signature" TEXT;

CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- ── VerificationRecord: per-proof chain columns ──────────────────────────
ALTER TABLE "VerificationRecord"
  ADD COLUMN "prevHash"  TEXT,
  ADD COLUMN "entryHash" TEXT NOT NULL DEFAULT '';

CREATE INDEX "VerificationRecord_proofId_createdAt_idx"
  ON "VerificationRecord"("proofId", "createdAt" DESC);

-- ── AuditChainCursor: single-row global lock target ──────────────────────
CREATE TABLE "AuditChainCursor" (
  "id"            TEXT      NOT NULL DEFAULT 'global',
  "lastEntryHash" TEXT,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuditChainCursor_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AuditChainCursor" ("id", "updatedAt") VALUES ('global', NOW())
  ON CONFLICT DO NOTHING;

-- ── VerificationChainCursor: per-proof lock target ───────────────────────
CREATE TABLE "VerificationChainCursor" (
  "proofId"       TEXT NOT NULL,
  "lastEntryHash" TEXT,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerificationChainCursor_pkey" PRIMARY KEY ("proofId")
);

ALTER TABLE "VerificationChainCursor"
  ADD CONSTRAINT "VerificationChainCursor_proofId_fkey"
  FOREIGN KEY ("proofId") REFERENCES "Proof"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BEFORE UPDATE trigger: 24h immutability for proof.hidden.revealed ────
--
-- Defense in depth. The application path (lib/audit.ts) never updates audit
-- rows; if a future bug or operator action tries to, this trigger blocks
-- modifications to recently-emitted hidden-vault reveal rows. After 24h the
-- trigger lets edits through (e.g. for legal hold / forensic export).
CREATE OR REPLACE FUNCTION audit_log_immutable_reveal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."action" = 'proof.hidden.revealed'
     AND (NOW() - OLD."createdAt") < INTERVAL '24 hours' THEN
    RAISE EXCEPTION
      'AuditLog row % is immutable: action=%, age < 24 hours',
      OLD."id", OLD."action"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_immutable_reveal_trigger ON "AuditLog";
CREATE TRIGGER audit_log_immutable_reveal_trigger
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_immutable_reveal();
