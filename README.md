# iProofNow™ — Backend

The API backend for **iProofNow**, a digital evidence-integrity platform.
Users create *proofs* (files + an attestation of who/where/when), seal them,
and get a tamper-evident, independently-verifiable record — anchored to the
Bitcoin blockchain and exportable as a cryptographically-signed evidence
package suitable for legal use.

Built API-first: Next.js 14 route handlers under `app/api/*`, PostgreSQL via
Prisma, S3-compatible object storage.

---

## What it does

| Area | Capability |
| --- | --- |
| **Auth** | Roll-your-own DB-backed sessions (SHA-256 token digests), argon2id passwords, role-aware dashboard. |
| **Proofs** | Create / update / seal proofs, multipart file upload, attestations, a hidden-vault mode whose proofs 404 even to org-mates. |
| **Vault & verify** | Owner-scoped vault with search/filter, audited hidden-vault reveals, public proof verification. |
| **Cases** | Group proofs into cases, build evidence packages (zipped court bundles). |
| **Background jobs** | A Postgres-backed queue (`SELECT … FOR UPDATE SKIP LOCKED`, retry + backoff): file hashing, package building, blockchain anchoring. |
| **Blockchain anchoring** | Real [OpenTimestamps](https://opentimestamps.org) — a proof's content digest is submitted to Bitcoin calendar servers and upgraded to a confirmed receipt. |
| **Tamper-evidence** | AuditLog rows form an HMAC-signed hash chain; per-proof verification chains; a DB trigger makes recent hidden-reveal audits immutable. |
| **Real verification** | Verifying a proof recomputes its digest and returns `VERIFIED` / `TAMPERED` / `NOT_FOUND` / `INDETERMINATE`, with a `CRYPTOGRAPHICALLY_VERIFIED` tier for Bitcoin-confirmed proofs. |
| **Signed evidence packages** | Every package carries a **detached ed25519 signature** — a court or opposing counsel can verify it **offline**, with no access to iProofNow, and cannot forge one. |

## Integrity model — the point of the product

- **Audit hash chain** — every audit row links to the previous via
  `entryHash = sha256(prevHash ‖ … ‖ canonical(meta))`, HMAC-signed. Any
  edit or deletion is detectable. `GET /api/audit/verify` walks it.
- **Bitcoin anchoring** — a sealed proof's digest is timestamped to the
  Bitcoin blockchain via OpenTimestamps; the receipt proves the content
  existed at a point in time, independent of iProofNow.
- **Signed packages** — evidence packages are signed with an **asymmetric**
  ed25519 key. The private key never leaves the signer; the public key is
  published in each package. Third parties verify with `scripts/verify-package.ts`
  — no database, no network, no trust in iProofNow required.

## Tech stack

- **Next.js 14** (App Router, route handlers) · **TypeScript** (`strict`)
- **PostgreSQL 16** + **Prisma**
- **S3-compatible storage** (MinIO in dev, swappable to AWS S3)
- **Vitest** integration tests against a real Postgres database
- **pnpm**

## Local development

Prerequisites: **Node 20**, **pnpm** (`corepack enable`), and **Docker**
(or a local PostgreSQL 16).

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres + MinIO
docker compose up -d

# 3. Configure environment
cp .env.example .env
#    then fill in the generated secrets (see comments in .env.example):
#    SESSION_COOKIE_SECRET, AUDIT_SIGNING_KEY, PACKAGE_SIGNING_PRIVATE_KEY

# 4. Apply the schema and seed dev data
pnpm prisma migrate deploy
pnpm prisma:seed

# 5. Run the API (listens on :3001)
pnpm dev
```

Seed users (dev only) — every role, password `dev-password-123`:
`individual@`, `company@`, `lawyer@`, `law-enforcement@`, `government@`,
`admin@` `iproofnow.dev`.

## Testing

```bash
createdb iproofnow_test     # once, if using a local Postgres
pnpm test                   # full integration suite against iproofnow_test
pnpm typecheck
```

Tests run against a real Postgres database (no mocks). Tests that need
object storage are skipped automatically when MinIO is unreachable.

## Operational scripts

| Script | Purpose |
| --- | --- |
| `prisma/seed.ts` | Seed dev users (refuses to run in production). |
| `scripts/backfill-audit-chain.ts` | Stamp hash-chain columns on pre-chain audit/verification rows. |
| `scripts/backfill-anchor-status.ts` | Gate the anchor-status enum migration. |
| `scripts/backfill-verification-result.ts` | Re-stamp verification chains after the result/tier format change. |
| `scripts/backfill-package-signatures.ts` | Retro-sign evidence packages built before signing existed. |
| `scripts/verify-package.ts` | **Standalone** offline verifier for a signed evidence package — no DB, no network. |

## Project layout

- `app/api/*` — route handlers (the API surface)
- `lib/*` — domain logic (auth, jobs, OTS anchoring, signing, serializers)
- `prisma/` — schema + migrations
- `tests/` — Vitest integration suite
- **`CLAUDE.md`** — the full architecture & design-decision record;
  read it before making changes.

## Out of scope

By deliberate product decision: C2PA provenance, perceptual hashing, OCR,
audio transcription, billing/payments, and email/SMTP are not implemented.
