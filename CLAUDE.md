# iProofNow Backend — Claude Code Notes

> **Read this first.** The four product-spec docs (HOW IT WORKS, Full Backend
> Developer Brief, Backend Developer Flow, IPROOF SYSTEM.pdf) live in the
> user's `~/Downloads`. You do **not** need to re-ingest them every session.
> Their content has already been distilled into this file plus the schema and
> route stubs. Re-read them only when you need product intent that isn't here.

---

## Stack — fixed decisions

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 14 App Router (route handlers under `app/api/*`) | Spec; matches the API-first surface |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Spec |
| ORM | Prisma + PostgreSQL 16 | Spec |
| Sessions | Roll-your-own per [lucia-auth.com/sessions/basic](https://lucia-auth.com/sessions/basic). DB-backed `Session` table; **`Session.id` is `SHA-256(token)` hex** — the raw token never lives in the DB. | Spec; lucia npm pkg is deprecated |
| Token gen | `@oslojs/crypto` (sha256) + `@oslojs/encoding` (base32, hex) | Spec |
| Password hash | `@node-rs/argon2` (argon2id, OWASP params) | Argon2 algorithm per spec; pure-binary install dodges Windows node-gyp pain |
| Storage | S3-compatible — MinIO in docker-compose, swappable to real S3 | Spec |
| Validation | Zod on every request body | Spec |
| Tests | Vitest, real Postgres `iproofnow_test` DB | Spec, "no mocks" rule |
| Package mgr | pnpm | Spec |

### Out of scope — do **not** elaborately stub

Blockchain / Polygon anchoring (Phase 7 = OpenTimestamps batching), OCR,
Whisper transcription, perceptual hashing, C2PA, "quantum-resistant" hashes,
forgery-detection ML, Stripe, billing, email/SMTP.

### Spec resolution

`Backend_Developer_Flow.txt` + `Full_Backend_Developer_Brief.txt` are
canonical. `IPROOF SYSTEM.pdf` is older — use it for **product intent only,
never tech choices**.

---

## File tree convention

```
app/
  layout.tsx, page.tsx       # placeholder — backend-only app
  api/
    auth/{login,logout,me,session}/route.ts
    dashboard/route.ts
    proofs/route.ts                             # create + list
    proofs/[proofId]/route.ts                   # detail + update
    proofs/[proofId]/files/route.ts             # upload + list
    proofs/[proofId]/attestation/route.ts       # upsert
    proofs/[proofId]/seal/route.ts              # finalize
    proofs/[proofId]/verify/route.ts            # record verification attempt
    proofs/[proofId]/verifications/route.ts     # history + counts
    vault/route.ts                              # owner-scoped list w/ q, filters, hasFiles/hasAttestation
    vault/[proofId]/reveal/route.ts             # audited hidden-vault reveal
    notifications/route.ts                      # list + unreadCount
    notifications/[notificationId]/route.ts     # PATCH read/unread
    notifications/read-all/route.ts             # mark-all
    audit/route.ts                              # actor-scoped audit query (admin sees all)
    cases/route.ts                              # create + list (owned ∪ same-org, q+status filter)
    cases/[caseId]/route.ts                     # detail + PATCH (owner-only)
    cases/[caseId]/proofs/route.ts              # POST link (atomic per-batch)
    cases/[caseId]/proofs/[proofId]/route.ts    # DELETE unlink
    cases/[caseId]/packages/route.ts            # POST request (atomic with job enqueue) + GET list
    packages/[packageId]/route.ts               # detail (downloadUrl when READY)
    proofs/[proofId]/export/route.ts            # JSON export (audited)
    proofs/[proofId]/anchor/verify/route.ts     # re-check OTS anchor (audited)
    audit/verify/route.ts                       # ADMIN-only chain integrity check
lib/
  db.ts                      # Prisma client singleton
  session.ts                 # generateSessionToken, createSession, validate (sliding refresh), invalidate*
  cookies.ts                 # session cookie set/clear/read
  password.ts                # argon2id hash/verify
  serializers.ts             # Role/Tier enum ↔ frontend casing, serializeUser()
  proof-serializers.ts       # Proof/File/Attestation ↔ frontend (async — signs download URLs)
  proof-guards.ts            # loadProofForRead/Write/Verify + assertNotSealed (hidden-vault 404)
  proof-search.ts            # q+filter Prisma where composer for Proof (route-agnostic)
  case-guards.ts             # loadCaseForRead/Write + caseIsOwner/SameOrg helpers
  case-serializers.ts        # Case + Package ↔ frontend (Package status enum)
  case-search.ts             # q+filter Prisma where composer for Case
  notifications.ts           # createNotification + NotificationType closed union
  storage.ts                 # S3Client singleton + putObject + getObjectStream + presigned GET (MinIO via forcePathStyle)
  jobs.ts                    # enqueueJob/runDueJobs/drainJobs (SKIP LOCKED + retry backoff + TerminalJobError)
  jobs/hash-file.ts          # proof_file.hash → fills ProofFile.fileHash + hashStatus
  jobs/build-package.ts      # evidence_package.build → zips manifest + files to S3, notifies owner
  jobs/anchor.ts             # proof.anchor → OTS submit: digest → calendars → PENDING anchor
  jobs/anchor-upgrade.ts     # proof.anchor.upgrade → poll calendars → CONFIRMED / re-enqueue / FAILED
  ots/proof-digest.ts        # computeProofDigest — sha256(audit chain + file hashes + attestation)
  ots/client.ts              # ONLY importer of `opentimestamps`: submit/upgrade/parse, bounded timeouts
  ots/bitcoin-explorer.ts    # read-only Esplora block lookup (anchor/verify lite check)
  rate-limit.ts              # RateLimiter interface + MemoryRateLimiter (Redis swap = lib/rate-limit-redis.ts)
  user-email.ts              # normalizeEmail() — single boundary for User.email writes/reads
  guards.ts                  # getCurrentSession, requireSession, requireRole(...roles)
  errors.ts                  # ApiError + typed subclasses + errorResponse() (incl. TooManyRequestsError)
  audit.ts                   # appendAudit (chained) + writeAudit (passthrough, fire-and-log)
  audit-sig.ts               # KMS-style HMAC-SHA-256 over entryHash; fail-fast on missing AUDIT_SIGNING_KEY
  audit-chain.ts             # verifyAuditChain — walks createdAt asc, recomputes + checks signatures
  verification-chain.ts      # appendVerificationRecord + verifyVerificationChain (per-proof chain)
  proof-verification.ts      # evaluateProof — real VERIFIED/TAMPERED/NOT_FOUND/INDETERMINATE + tier
  logger.ts                  # JSON line logger
middleware.ts                # CORS for /api/* (allowlist + credentials)
prisma/
  schema.prisma              # 17 models + 10 enums
  seed.ts                    # 6 users (one per role); refuses to run in production
tests/
  global-setup.ts            # prisma db push --force-reset against *_test DB
  test-env.ts                # mocks next/headers cookies(); pins NODE_ENV=test
  cookie-jar.ts              # in-memory jar that quacks like cookies()
  helpers.ts                 # truncateAll, createTestUser/Org/Proof/ProofFile/Anchor/Case/Package/Notification/Verification, loginAs, joinOrg, linkCaseProof, buildJsonRequest, buildMultipartRequest
  ots-stub.ts                # in-process stub OTS calendar + Bitcoin explorer for tests
  auth.test.ts dashboard.test.ts proofs.test.ts vault.test.ts vault-reveal.test.ts verify.test.ts notifications.test.ts audit-query.test.ts cases.test.ts case-proofs.test.ts case-packages.test.ts jobs.test.ts hash-file.test.ts build-package.test.ts export.test.ts rate-limit.test.ts audit-chain.test.ts audit-sig.test.ts verification-chain.test.ts audit-immutable-reveal.test.ts anchor.test.ts anchor-upgrade.test.ts anchor-verify.test.ts verification-result.test.ts
docker-compose.yml           # postgres:16-alpine + minio + minio-init bucket creator
.env.example                 # all required env vars; DATABASE_URL_TEST must end in _test
```

---

## Entity summary (17 models)

`User`, `Organization`, `Session`, `Proof`, `ProofFile`, `ProofAttestation`,
`VerificationRecord`, `Notification`, `Case`, `CaseProof`, `EvidencePackage`,
`AuditLog`, `PreservationConfig`, `Job`, `ProofAnchor`, `AuditChainCursor`,
`VerificationChainCursor`.

Enums: `Role` (INDIVIDUAL|COMPANY|LAWYER|LAW_ENFORCEMENT|GOVERNMENT|ADMIN),
`ProofStatus` (DRAFT|SEALED), `Visibility` (PRIVATE|PUBLIC|ORG),
`PackageStatus` (PENDING|READY|FAILED), `SubscriptionTier`
(FREE|PRO|BUSINESS|ENTERPRISE), `HashStatus` (PENDING|COMPLETE|FAILED),
`JobStatus` (PENDING|RUNNING|COMPLETE|FAILED),
`AnchorStatus` (STUB|PENDING|CONFIRMED|FAILED),
`VerificationResult` (VERIFIED|TAMPERED|NOT_FOUND|INDETERMINATE),
`VerificationTier` (HASH_VERIFIED|CRYPTOGRAPHICALLY_VERIFIED).

**Phase 2 schema additions**: `Proof.roleContext String?` (freeform role
context on draft creation); `ProofFile.hashStatus HashStatus @default(PENDING)`
(lets the frontend distinguish "not computed yet" from "failed" from
"legacy"; the Phase 5 hash worker flips to COMPLETE when `fileHash` is
populated).

**Phase 5 schema additions**: `Job` (generic queue row, claimed via
`SELECT … FOR UPDATE SKIP LOCKED`); `ProofAnchor` (1:1 with Proof,
Phase 5 writes status='STUB' rows from the anchor stub worker — Phase 7
overwrites otsProof with a real OpenTimestamps receipt and flips
status='CONFIRMED').

**Phase 6 schema additions**:
- `AuditLog.prevHash String?`, `AuditLog.entryHash String`, `AuditLog.signature String?` —
  tamper-evident hash chain. `entryHash = sha256(prevHash || actorUserId ||
  entityType || entityId || action || canonical(meta) || createdAt iso)`.
  `signature = HMAC-SHA-256(entryHash)` under `AUDIT_SIGNING_KEY`.
- `VerificationRecord.prevHash String?`, `VerificationRecord.entryHash String` —
  same chain idea, scoped per-proof rather than global.
- `AuditChainCursor` (single row, `id='global'`) — the lock target that
  serializes audit chain inserts via `SELECT … FOR UPDATE`. `lastEntryHash`
  mirrors the chain head so appends don't re-scan AuditLog.
- `VerificationChainCursor` (one row per proof, `proofId @id`) — per-proof
  lock target. Heavy-traffic proofs serialize against themselves only.
- BEFORE UPDATE trigger on `AuditLog`: rejects modifications to rows where
  `action='proof.hidden.revealed'` AND `now() - createdAt < 24h`. Defense
  in depth — the application path never updates audit rows.

**Phase 7 schema additions** (`ProofAnchor` evolution):
- `status` is now the `AnchorStatus` enum (was a free `String`). The Phase 7
  migration converts the column via `USING status::"AnchorStatus"`;
  `scripts/backfill-anchor-status.ts` is the documented gate — run it first
  to assert no legacy row holds a value outside the enum (Phase 5 only ever
  wrote `'STUB'`, so it's a no-op in practice).
- `contentHash Bytes?` — the 32-byte sha256 digest actually submitted to the
  OTS calendars. Stored so `anchor/verify` (and the Phase 8 tamper check)
  needn't deserialize `otsProof`. Nullable only for legacy STUB rows.
- `bitcoinBlockHeight Int?`, `bitcoinBlockHash String?`, `confirmedAt
  DateTime?`, `upgradedAt DateTime?` — populated on the CONFIRMED transition
  from the Bitcoin attestation + block explorer.

**Phase 8 schema additions** (`VerificationRecord` evolution):
- `result` is now the `VerificationResult` enum (was a free `String` that
  Phase 3–7 always wrote as `'verified'`). Migration converts via
  `USING upper(result)::"VerificationResult"`.
- `tier VerificationTier?` — strength tier, set only for a `VERIFIED`
  result, null otherwise.
- The entryHash composition gained a `tier` slot, so every pre-Phase-8
  verification chain entryHash is stale until re-stamped by
  `scripts/backfill-verification-result.ts`.

Every FK is indexed. Common query columns indexed: `Proof.ownerUserId`,
`Proof.orgId`, `(Proof.ownerUserId,status)`, `(Proof.orgId,status)`,
`Proof.createdAt desc`, `AuditLog.(entityType,entityId,createdAt desc)`,
`Notification.(userId,readAt)`, `Notification.(userId,createdAt desc)`,
`Session.userId`, `Session.expiresAt`.

---

## API contracts (Phase 1)

### Success vs error envelope (intentionally asymmetric)

**Success** is shaped to what the frontend reads: raw `{ user }`,
`{ ok: true }`, or domain payloads. **Errors** always go through
`lib/errors.ts → errorResponse()` and look like:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Unauthorized" } }
```

This is by design — successes and errors are structurally different so
clients can branch on `res.ok`/HTTP status without runtime shape sniffing.
Both shapes are documented here; do not "harmonize" them later.

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | none | body `{email, password}`. 200 → `{ user }` + `Set-Cookie: session=…`. 401 on bad creds. |
| `POST` | `/api/auth/logout` | optional | Idempotent. Clears cookie + invalidates `Session` row. 200 always. |
| `GET`  | `/api/auth/me` | required | Canonical session-restore. 200 → `{ user, role }`. 401 otherwise. |
| `GET`  | `/api/auth/session` | required | Frontend-compat alias. 200 → `{ user }` only (matches what `lib/store/auth-store.ts:73` reads). |
| `GET`  | `/api/dashboard` | required | Role-aware payload (see "Dashboard contract" below). |

### `serializeUser()` shape

`SerializedUser` is the **only** way users get serialized. Lives in
`lib/serializers.ts`. Never inline `.toLowerCase()` on a role outside of
`roleToFrontend()` — that is where casing drift starts.

```ts
{
  id, email, name,
  role: 'individual' | 'company' | 'lawyer' | 'law_enforcement' | 'government' | 'admin',
  subscriptionTier: 'free' | 'pro' | 'business' | 'enterprise',
  organizationId: string | null,
  organizationName: string | null,
  preferences: { theme:'system', language:'en', timezone:'UTC', notifications:{...all true}, twoFactorEnabled:false },
  createdAt, lastLogin
}
```

**`stats` is intentionally NOT on `SerializedUser`.** Stats live on
`/api/dashboard` only. Rationale: `/me` is called many times per session;
`/dashboard` is called once. Computing stats inside the user serializer is a
performance footgun. The frontend's `mapApiUser` falls back to zeros via
`?? 0`, so omitting is safe.

`preferences` is hard-coded defaults today (no DB column). When persistence
is added, store as a single `Json` column on `User` — do **not** flatten into
columns.

### Dashboard contract — provisional

```ts
{
  role: FrontendRole,
  stats: { totalProofs, sealedProofs, recentVerifications },
  recentProofs: ProofSummary[],         // last 5 own/org proofs
  recentActivity: AuditSummary[],       // last 10 of own audit rows
  notificationsSummary: { unread, total },
  roleWidgets: { ... }                  // role-specific, see below
}
```

`roleWidgets` per role:

- **individual** → `{ personalProofs }`
- **company** → `{ orgProofs, teamMembers }`
- **lawyer** → `{ activeCases, packagesReady }`
- **law_enforcement** → `{ activeCases }`
- **government** → `{ complianceItems }`
- **admin** → `{ totalUsers, totalOrgs }`

The frontend zip currently does **not** call `/api/dashboard` (renders from
its own Zustand mock store, see `lib/hooks/use-api.ts`). When the frontend
gets wired to this endpoint, the shape may need adjustment — treat it as
provisional and revisit then.

---

## API contracts (Phase 2 — Proofs + Files + Attestation + Seal)

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST`  | `/api/proofs` | required | body `{proofType, categoryKey, title, description?, roleContext?}`. 201 → `{ proof }`. Inherits `orgId` from user. Audits `proof.created`. |
| `GET`   | `/api/proofs` | required | `?status=&category=&scope=&page=&pageSize=`. Default scope = own + same-org non-private, hidden excluded. `?scope=hidden` → caller's hidden-vault proofs only; audits `proof.hidden.listed`. 200 → `{ proofs: ProofSummary[], pagination }`. |
| `GET`   | `/api/proofs/:proofId` | required | Full detail. Owner OR (same-org AND visibility≠PRIVATE) OR PUBLIC. **Hidden vault: returns 404 to non-owner — does not leak existence.** 200 → `{ proof }`. |
| `PATCH` | `/api/proofs/:proofId` | required | Owner-only (403 otherwise). 409 if SEALED. Preservation/hidden flags upsert `PreservationConfig`. Audits `proof.updated`. 200 → `{ proof }`. |
| `POST`  | `/api/proofs/:proofId/files` | required | `multipart/form-data` field `file`. Max 100 MB. Mime allowlist: `image/*`, `video/*`, `audio/*`, `application/pdf`, `text/plain`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`. Owner-only. 409 if SEALED. 201 → `{ file }` (full serialized file with presigned `downloadUrl`). Audits `proof.file.uploaded`. |
| `GET`   | `/api/proofs/:proofId/files` | required | Read access. 200 → `{ files: [{ ...meta, downloadUrl }] }` — `downloadUrl` is a fresh presigned GET (15 min TTL). |
| `POST`  | `/api/proofs/:proofId/attestation` | required | Upsert (unique per proof). Owner-only. 409 if SEALED. `attestationFileId` (if provided) must belong to this proof. 200 → `{ attestation }`. Audits `proof.attestation.saved`. |
| `POST`  | `/api/proofs/:proofId/seal` | required | Owner-only. Transitions DRAFT→SEALED; stamps `sealedAt`. 200 → `{ proofId, status:'sealed', sealedAt }`. Audits `proof.sealed`. |

### Seal failure shape

Seal accumulates ALL blockers so the frontend can surface them together
(no whack-a-mole validation). The reason set is **closed** — adding a
new reason is a deliberate contract change, never a freeform string.

```json
{
  "error": {
    "code": "SEAL_REQUIREMENTS_NOT_MET",
    "message": "Proof cannot be sealed",
    "details": { "reasons": ["missing_title", "missing_file", "missing_attestation"] }
  }
}
```

`SealBlockReason = 'missing_title' | 'missing_file' | 'missing_attestation' | 'already_sealed'`

### File URL namespacing

The file serializer returns `downloadUrl`, not `url`. When thumbnails /
transcoded variants arrive later they get their own fields (`thumbnailUrl`,
`previewUrl`) — renaming `url` later would break clients.

### Hidden-vault invariant (critical)

A proof with `PreservationConfig.hiddenVaultMode = true` is **404 to
everyone except the owner** — including org-mates who would normally see
it under default visibility rules. Do not change this to 403; the whole
point is that the proof's existence is not revealed. Tested in
`tests/proofs.test.ts` and `tests/vault-reveal.test.ts` /
`tests/verify.test.ts`.

---

## API contracts (Phase 3 — Vault + Verify + Notifications + Audit)

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET`   | `/api/vault` | required | Owner-scoped only (no org). `?q=&proofType=&category=&status=&visibility=&scope=hidden&sortBy=(createdAt\|sealedAt\|title)&sortDir=(asc\|desc)&page=&pageSize=`. Rows carry `hasFiles`/`hasAttestation` booleans. `?scope=hidden` audits `proof.hidden.listed`. |
| `POST`  | `/api/vault/:proofId/reveal` | required | Owner-only. 403 if visible-but-not-owner, 404 if missing or hidden-not-owner. Body `{ reason: 'case_review'\|'export_prep'\|'user_browse'\|'other', reasonText? }` — `reasonText` required when `reason === 'other'` (400 otherwise). 200 → `{ proof }` (same as GET /api/proofs/:id). Audits `proof.hidden.revealed` with reason. Does **not** flip `hiddenVaultMode`. |
| `POST`  | `/api/proofs/:proofId/verify` | conditional | PUBLIC proofs verifiable without auth. PRIVATE/ORG require session + read access. Hidden → 404. Body `{ method: 'hash'\|'qr'\|'link', context? }`. 200 → `{ verificationId, proofId, result, verifiedAt }`. Phase 3 `result` is always `'verified'`. Audits `proof.verified`. |
| `GET`   | `/api/proofs/:proofId/verifications` | conditional | Same access rules as `/verify`. Paginated history + `counts: { verified, notFound, tampered }`. No audit (metadata read). |
| `GET`   | `/api/notifications` | required | `?unreadOnly=&page=&pageSize=`. Session-user scope. 200 → `{ notifications, unreadCount, pagination }`. No audit. |
| `PATCH` | `/api/notifications/:notificationId` | required | `{ read: boolean }`. Missing → 404, foreign → 403 (intentional asymmetry with vault's 404-mask; notifications aren't sensitive content). No audit. |
| `POST`  | `/api/notifications/read-all` | required | 200 → `{ ok, updated }`. No audit. |
| `GET`   | `/api/audit` | required | `?action=&entityType=&entityId=&since=&until=&page=&pageSize=`. Non-admin → `actorUserId === session.user`; ADMIN → all rows. Audits `audit.queried`; `meta.filterKeys` records which keys were applied (keys only, not values). |

### Vault scope — why owner-only, not org

`/api/proofs` already handles "own + same-org non-private" discovery. The
vault surface is deliberately narrower: it is the owner's private staging
and archive UI, not a collaborative browser. Keeping cross-org listing on
`/api/proofs` and owner-only on `/api/vault` is what lets the frontend
render them as separate tabs without ambiguous scoping.

### Proof-search `q` semantics

`q` is ILIKE against `title` and `description`, plus exact-match on
`peopleInvolved` array entries. Phase 5+ will swap this for a Postgres
tsvector column so partial matches on tag entries work.

### Vault row shape (`hasFiles` / `hasAttestation`)

Vault rows extend the `ProofSummary` shape with two booleans so the list
UI can render completion badges without fetching detail per row. Computed
via a cheap projection — `files: { select:{id:true}, take:1 }` and
`attestation: { select:{id:true} }` — no full load.

### Reveal response vs `hiddenVaultMode`

The reveal endpoint returns the **full proof detail** but leaves
`hiddenVaultMode` untouched. That's the point: reveals are one-shot,
audited retrievals — the proof stays hidden afterward. If an owner wants
to un-hide permanently, that's a `PATCH /api/proofs/:id` with
`hiddenVaultMode: false`, audited as `proof.updated`.

---

## API contracts (Phase 4 — Cases + Case↔Proof + Evidence Packages)

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST`   | `/api/cases` | required | body `{title, description?, orgId?}`. Inherits `orgId` from caller if not given. 201 → `{ case }`. Audits `case.created`. |
| `GET`    | `/api/cases` | required | `?scope=(owned\|org)&q=&status=&page=&pageSize=`. Default scope = owned ∪ same-org. `q` ILIKE on title+description; `status` exact match. `?scope=org` with no `user.orgId` short-circuits to an empty page. Each row carries `linkedProofCount` + `packageCount`. No audit. |
| `GET`    | `/api/cases/:caseId` | required | Owner OR same-org → 200; otherwise 404 (don't leak existence). Response: `{ case, proofs: ProofSummary[], packages: PackageSummary[] }`. **Linked-proof projection differs by access path** — owner sees every linked proof; same-org peers see only non-PRIVATE non-hidden linked proofs (mirrors the `/api/proofs` ladder). No audit in Phase 4. |
| `PATCH`  | `/api/cases/:caseId` | required | Owner-only (403 otherwise; 404 missing). Updatable: `title`, `description`, `status`. Empty body → 400. Audits `case.updated` with `meta.fields` (touched keys only, no values). |
| `POST`   | `/api/cases/:caseId/proofs` | required | Case-owner only. Body `{ proofIds: string[] }`. **Atomic** — every proof must exist AND be owned by the caller; one foreign / missing id rolls back the whole batch (no partial links, no audit rows). Idempotent re-link via the `(caseId,proofId)` unique constraint; audits fire only for newly-created links. 201 → `{ linked: number }`. Audits `case.proof.linked` once per added proof. |
| `DELETE` | `/api/cases/:caseId/proofs/:proofId` | required | Case-owner only. 204 on success; 404 when the link doesn't exist. Audits `case.proof.unlinked`. |
| `POST`   | `/api/cases/:caseId/packages` | required | Case owner OR (same-org AND role ∈ {LAWYER, LAW_ENFORCEMENT}). Body `{ packageType: 'court_bundle'\|'discovery'\|'custom' }`. **Phase 4 stub** — synchronously writes a row at status=PENDING. The actual zip-assembly worker is Phase 5. 202 → `{ packageId, status: 'pending' }`. Audits `package.requested`. Notifies case owner with `evidence_package_requested`. |
| `GET`    | `/api/cases/:caseId/packages` | required | Same access as case detail. 200 → `{ packages: PackageSummary[] }`. No audit. |
| `GET`    | `/api/packages/:packageId` | required | Package creator OR case owner OR same-org as case. Otherwise 404. Response: `{ package, downloadUrl? }`. `downloadUrl` is **only present at the top level** when status=READY AND storagePath is populated — keeps the frontend's "do I have a link?" check a simple `'downloadUrl' in res`. No audit. |

### Why per-entity search files

Phase 4 generalized search by **splitting**, not bolting: `lib/case-search.ts`
sits next to `lib/proof-search.ts` rather than absorbing it. Each entity
will accumulate its own column quirks (peopleInvolved tag matching for
proofs; case status taxonomy here) and a single helper would force every
caller to opt out of irrelevant joins. Keep them separate.

### Case write vs read symmetry

Read leaks nothing: foreign caller → 404 (mirrors hidden-vault rule).
Write does leak existence: foreign caller → 403, not 404. Cases don't
have a hidden-vault analogue, and a 403 on PATCH is acceptable signal
loss versus the cost of rerouting writes through `loadCaseForRead` first.
If we ever add a "case sealed" or "case archived & locked" state where
existence becomes sensitive, revisit.

### `case.detail.viewed` is reserved

Owner / same-org reads are routine and not audited in Phase 4. The
`case.detail.viewed` action is reserved for a future share grant
mechanism in which a non-owner gains access via an explicit share. The
`GET /api/cases/:caseId` handler carries a `// TODO(phase-share):` stub
at the audit emit point so the wiring is obvious when share lands.

### Package recipient (`evidence_package_requested`)

Recipient is the **case owner**, regardless of who initiated. When the
owner self-requests we still notify — package builds are async, so a
notification is the only consistent signal that something is in flight.
Mirrors the `proof_sealed` self-notify pattern.

---

## API contracts (Phase 5 — Background jobs + Hardening + Exports)

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/proofs/:proofId/export` | required | Same access ladder as `loadProofForRead` (owner / same-org-non-PRIVATE / PUBLIC; hidden-vault → 404 to non-owners). Response: `{ proof, anchor }` where `anchor` is `{ status, anchoredAt, otsProof: base64 }` or `null`. Audits `proof.exported` with `meta.fileCount`, `meta.hasAttestation`, `meta.anchored`. |

### Routes that gained side effects

| Method | Path | New behavior |
| --- | --- | --- |
| `POST` | `/api/proofs/:id/seal` | Wraps SEALED transition + `proof.anchor` enqueue in a single `prisma.$transaction` so a row stamped SEALED implies a job is queued. |
| `POST` | `/api/proofs/:id/files` | Enqueues `proof_file.hash` after the file row finalizes. Best-effort — enqueue failure logs via `writeAudit({action:'job.failed', stage:'enqueue'})` but never breaks the upload response. |
| `POST` | `/api/cases/:id/packages` | Wraps `EvidencePackage` create + `evidence_package.build` enqueue in `prisma.$transaction` so the PENDING row + the job row are atomic. |
| `POST` | `/api/auth/login` | Rate-limited via `consume(ipKey)` BEFORE the argon2 verify — 5 attempts / 15min / IP. 429 → `auth.login.failure` audit with `meta.reason='rate_limited'`. Email lookup now goes through `normalizeEmail()`. |
| `middleware.ts` | (all `/api/*`) | Rejects requests with `Content-Length > 100MB` with 413 before Next routes the body to a handler. |

### Job system (`lib/jobs.ts`)

Public surface is just three functions:
- `enqueueJob(type, payload, { runAfter?, tx? })` — `tx` lets callers
  enqueue inside their own transaction (used by seal / upload / package
  request) so "state change ↔ job exists" stays atomic.
- `runDueJobs()` — claim one due `Job` via raw SQL with
  `SELECT … FOR UPDATE SKIP LOCKED` so multiple worker instances are safe
  by default. Handler runs OUTSIDE the transaction so a slow handler
  doesn't hold the row lock.
- `drainJobs(maxIterations=50)` — loops `runDueJobs()` until idle, with
  a hard cap so a broken handler can't hang the suite. Test/ops helper.

Retry policy: max 3 attempts, exponential backoff (1s → 4s → terminal
FAILED). Terminal FAILED writes an internal `job.failed` audit row with
the truncated error so ops can spot persistently-broken handlers without
scraping logs.

**`TerminalJobError` (Phase 7)**: a handler that throws `TerminalJobError`
(exported from `lib/jobs.ts`) tells the runner to skip the remaining retry
budget and fail the job immediately — one `job.failed` audit, no backoff.
Use it for outcomes the handler knows are unrecoverable (e.g. an OTS
upgrade still unconfirmed after the 7-day cap). An ordinary `Error` keeps
the standard 3-attempt retry.

**Critical Postgres footgun**: the SKIP-LOCKED claim compares
`"runAfter"` against `(NOW() AT TIME ZONE 'UTC')::timestamp`, NOT plain
NOW(). Prisma stores `DateTime` as `timestamp(3)` (no tz) interpreted as
UTC, but a session-local NOW() cast to `timestamp` shifts by the session
TZ — so a non-UTC session would silently filter out rows that were due
"now". The explicit AT TIME ZONE conversion compares wall-clocks in the
same frame regardless of session timezone. **Don't remove this without
re-running tests on a non-UTC session** (e.g. `SET TimeZone =
'America/New_York'`).

### Cron tick is operational config

`runDueJobs()` is exposed; how it gets called in prod is not Phase 5's
problem. Common options: `setInterval(runDueJobs, 5000)` in a sidecar
process, a Kubernetes CronJob hitting an `/api/_internal/runJobs`
endpoint, or a real queue once load demands it. The handler interface
(`(payload, ctx) => Promise<void>`) doesn't change with any of those.

### Job handler registry

Handlers are registered via dynamic import inside `lib/jobs.ts →
loadHandlers()`:

- `proof_file.hash` (`lib/jobs/hash-file.ts`) — streams the S3 object
  through `createHash('sha256')` rather than buffering, writes back
  `ProofFile.fileHash` and flips `hashStatus` PENDING → COMPLETE/FAILED.
  Missing file (deleted between enqueue and run) is a terminal no-op.
- `evidence_package.build` (`lib/jobs/build-package.ts`) — uses
  `archiver` to stream `manifest.json` + every linked proof's files into
  a zip on S3, flips `EvidencePackage` to READY + populates
  `storagePath`, notifies the case owner with `evidence_package_ready`.
  Missing package id is a terminal no-op. Mid-zip throws retry; only the
  3rd (terminal) attempt flips the EvidencePackage row to FAILED so
  transient S3 hiccups don't toggle READY/FAILED on every retry.
- `proof.anchor` (`lib/jobs/anchor.ts`) — Phase 7 OTS submit. Computes the
  proof content digest, submits it to the OTS calendars, writes a
  `ProofAnchor` at `status='PENDING'` with `contentHash` recorded, and
  enqueues the first `proof.anchor.upgrade` at +1h (atomically with the
  anchor row). If file hashes aren't COMPLETE yet it self-re-enqueues at
  +60s (cap 15 waits → terminal). Idempotent — a proof already PENDING or
  CONFIRMED is skipped; a legacy STUB / prior FAILED row is re-anchored.
- `proof.anchor.upgrade` (`lib/jobs/anchor-upgrade.ts`) — Phase 7 OTS
  upgrade poll. Confirmed → full receipt + `status='CONFIRMED'` + Bitcoin
  block height/hash. Not ready → re-enqueue on the backoff schedule
  (`[6,24,24,24,24,24,24]` h; ~6.3 days total inside a 7-day ceiling).
  Cap exceeded → `ProofAnchor.status='FAILED'` + `TerminalJobError`.

See "API contracts (Phase 7)" below for the OTS architecture, the digest
composition, and why calendar round-trips are deliberately not audited.

### Hardening

- **Login rate limit** (`lib/rate-limit.ts`): in-memory token bucket, 5
  attempts / 15min / IP. Tests pass an isolated `Map` + `now()` override
  to avoid leaking state between cases. Prod with horizontal scaling
  swaps the Map for Redis (`INCR key EX windowSec`) — call site stays
  identical. The gate runs BEFORE argon2 verify so brute-force attempts
  can't amplify the intentional verify slowness against the server.
- **Body cap** (`middleware.ts`): rejects `Content-Length > 100MB` with
  413 before the multipart parser sees the body. Per-file route still
  enforces its own limit for chunked / lying clients.
- **Email normalization** (`lib/user-email.ts`): single `normalizeEmail`
  helper used at every User-creation / lookup site. Keeps the `email`
  unique constraint from accumulating mixed-case duplicates without
  depending on Postgres `citext`.

---

## API contracts (Phase 6 — Chain hardening + audit immutability + signed entries)

### Endpoint

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/audit/verify` | ADMIN | `?since=ISO8601` optional. 200 → `{ ok: true, count }` or `{ ok: false, brokenAt, reason, expected, actual }`. `reason ∈ {'hash_mismatch','signature_mismatch','broken_link'}`. The verifier seeds `prevHash` from the row immediately before `since` so truncation at the boundary is detected. Self-emits `audit.chain.verified`. 403 to non-admins. |

### Audit chain invariants

- **Hash composition**: `entryHash = sha256(prevHash || actorUserId || entityType || entityId || action || canonicalJson(meta) || createdAt iso)`. Fields are NUL-delimited so distinct values can't collide via concatenation. `canonicalJson` does recursive sorted-key encoding so meta-key ordering doesn't change the hash.
- **Serialization**: every `appendAudit` opens a transaction, takes `SELECT … FOR UPDATE` on `AuditChainCursor` (`id='global'`), reads the chain head from `lastEntryHash`, inserts the new row, updates the cursor. Concurrent appends are serialized by Postgres row locks.
- **Signature**: HMAC-SHA-256 over `entryHash` under `AUDIT_SIGNING_KEY` (32 bytes). Stored as `signature String?` — null tolerated only for backfilled pre-Phase-6 rows; new rows always populate. `lib/audit-sig.ts` is the swap point for a real KMS later.
- **Why a single global cursor instead of sharding**: at current write volume (handfuls of audit rows per request, low-tens of req/s), a single `SELECT FOR UPDATE` is the simplest correct design and won't be the bottleneck. When audit insert rate justifies sharding (~hundreds/sec), the swap is a per-shard cursor table + a hashing function `(actorUserId, entityType) → shard`. **Per-proof verification chains already shard naturally** — they were sharded from day one because individual proofs vary wildly in verify volume.
- **`writeAudit` is the public passthrough**: every Phase 1–5 emit site keeps using it. Failures don't propagate (still fire-and-log). Code that needs the throw-on-failure semantics calls `appendAudit` directly.

### Verification record chain invariants

- **Per-proof, never global**: each proof has its own `VerificationChainCursor` row keyed by `proofId`. A heavy-traffic public proof being verified thousands of times serializes against itself only.
- **Hash composition**: `entryHash = sha256(prevHash || proofId || method || result || canonicalJson(requesterContext) || createdAt iso)`. Same NUL-delimited / canonical-JSON rules as audit.
- **No HMAC signature**: the chain itself + the paired `proof.verified` audit row (which references the verification record id) provides tamper detection. Add HMAC if a future threat model justifies the extra storage.

### Audit-row immutability

- **Application path never updates AuditLog rows.** Every Phase 1–6 emit site is INSERT-only.
- **DB trigger backstop**: BEFORE UPDATE on `AuditLog` raises a `check_violation` when `OLD.action = 'proof.hidden.revealed'` AND `(now() - OLD.createdAt) < 24h`. Defense in depth — protects against operator error / future bugs / direct SQL changes inside the 24h window where a fraudulent reveal cover-up would be most likely.
- **Outside the 24h window** updates are allowed (e.g. legal hold / forensic export workflows). The chain's hash check still surfaces any tampering on the next `audit.chain.verified` call regardless of when it happened.

### Backfill (`scripts/backfill-audit-chain.ts`)

One-shot. Walks existing `AuditLog` rows in `(createdAt asc, id asc)` order, computes prevHash/entryHash/signature, writes them back. Same for `VerificationRecord` (per-proof). Idempotent — rows already stamped (`entryHash <> ''`) are skipped. Refuses to run in `NODE_ENV=production` without `--allow-prod`. Recent `proof.hidden.revealed` rows go through `SET LOCAL session_replication_role = 'replica'` to bypass the immutability trigger for the backfill UPDATE only.

---

## API contracts (Phase 7 — Real OpenTimestamps anchoring)

### Endpoint

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/proofs/:proofId/anchor/verify` | required | Same access ladder as `loadProofForRead` (owner / same-org-non-PRIVATE / PUBLIC; hidden-vault → 404). Re-checks the OTS anchor *without trusting the DB*: parses the stored receipt, and for CONFIRMED reads the Bitcoin attestation + confirms the block via the explorer; for PENDING re-queries the calendars live (no DB write). 200 → `{ anchored, status, contentHashMatches, confirmed, bitcoin: { height, blockHash, time } \| null, checkedAt }`. No anchor / legacy STUB → `{ anchored: false }`. Audits `proof.anchor.verified`. |

`GET /api/proofs/:proofId/export` gained anchor fields: `status`, `confirmedAt`, `contentHash` (hex), `bitcoinBlockHeight`, `bitcoinBlockHash`, and `verifyUrl` (the route above). `otsProof` stays base64.

### OTS architecture

- **Library**: the official `opentimestamps` npm package, used only inside `lib/ots/client.ts` — the single import site, so a future swap (or self-hosted calendar) is a one-file rewrite plus `types/opentimestamps.d.ts`. The package ships a broken `main`; `next.config.mjs` marks it (and `@node-rs/argon2`) `serverComponentsExternalPackages`, and `vitest.config.ts` aliases the bare specifier to `index.js`.
- **Two-phase flow**: `proof.anchor` submits the digest (→ `PENDING`); `proof.anchor.upgrade` polls the calendars on a backoff schedule until a Bitcoin block attestation appears (→ `CONFIRMED`) or the ~7-day cap is hit (→ `FAILED`).
- **Content digest** (`lib/ots/proof-digest.ts`): `sha256` over NUL-delimited sections — every `AuditLog.entryHash` for the proof (ordered), every `ProofFile.fileHash` (ordered), and canonical JSON of the `ProofAttestation`. Folding in the audit *entryHashes* means the anchor transitively commits to the proof's whole Phase-6 audit chain. Stored verbatim in `ProofAnchor.contentHash`.
- **Timeouts**: per-calendar bound of 15s (5s connect + 10s body intent — the library exposes only one coarse socket timeout, so we enforce the sum), applied both on the `RemoteCalendar` and as a `Promise` race. Calendars are fanned out in parallel; submit succeeds if ≥1 accepts.
- **Verification is "lite"**: `anchor/verify` re-checks against a calendar + a block explorer (`BITCOIN_EXPLORER_URL`, Esplora shape). It does not re-verify the merkle path locally — the `otsProof` in the export remains independently verifiable with the `ots` CLI for anyone wanting the full cryptographic check.

### Why OTS round-trips are not audited

A single anchored proof generates ~1 submit + up to ~8 upgrade polls over a
week. Writing each calendar round-trip to the audit chain would bloat the
**global** `AuditLog` chain (every append serializes through one cursor —
see Phase 6) for zero investigative value: the `ProofAnchor` row and its
`status` transitions (STUB→PENDING→CONFIRMED/FAILED) are already the source
of truth, observable directly. `lib/audit.ts` is untouched by Phase 7. Only
the user-initiated `proof.anchor.verified` read is audited.

### Backfill (`scripts/backfill-anchor-status.ts`)

Gate for the `status` enum migration. Asserts (via raw SQL, pre-migration)
that no existing `ProofAnchor.status` value falls outside the `AnchorStatus`
enum, so the migration's `USING status::"AnchorStatus"` cast can't abort
mid-run. A no-op in practice (Phase 5 only wrote `'STUB'`). Refuses prod
without `--allow-prod`.

---

## API contracts (Phase 8 — Verification result enrichment)

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/proofs/:proofId/verify` | conditional | Result is now **real** (was always `'verified'`). Response: `{ verificationId, proofId, result, tier, verifiedAt }`. `result ∈ VERIFIED\|TAMPERED\|NOT_FOUND\|INDETERMINATE`; `tier ∈ HASH_VERIFIED\|CRYPTOGRAPHICALLY_VERIFIED\|null`. Audits `proof.verified` (meta gains `result` + `tier`). |
| `GET` | `/api/proofs/:proofId/verifications` | conditional | `counts` now covers all four results (`{ verified, tampered, notFound, indeterminate }`); new `tiers: { hashVerified, cryptographicallyVerified }`. Each row carries `tier`. |

### Result & tier taxonomy (closed contract)

`evaluateProof` (`lib/proof-verification.ts`) recomputes the proof's content
digest and compares it to `ProofAnchor.contentHash`:

- **`VERIFIED`** — recomputed digest matches. Tier is
  `CRYPTOGRAPHICALLY_VERIFIED` when the anchor is Bitcoin-`CONFIRMED`, else
  `HASH_VERIFIED` (PENDING/FAILED anchor — content matches but not yet, or
  never, on Bitcoin).
- **`TAMPERED`** — recomputed digest ≠ `contentHash`. The proof's content
  changed after anchoring. `tier = null`.
- **`NOT_FOUND`** — no `ProofAnchor`, or the anchor has no `contentHash`
  baseline (DRAFT / unanchored-sealed / legacy STUB). `tier = null`.
- **`INDETERMINATE`** — an anchor exists but the digest can't be computed
  right now (a `ProofFile` hash is PENDING or FAILED). Transient for a
  normally-anchored proof — caller should retry. `tier = null`.

Adding a result or tier value is a deliberate contract change. `proof.verified`
is audited for **every** verify, anonymous PUBLIC ones included — so a
`TAMPERED` finding is never silent.

### Content digest must be time-stable (Phase 8 fix)

`computeProofDigest` previously folded in *every* `AuditLog` row tagged
`entityType='Proof'`. But `proof.verified` / `proof.exported` /
`proof.anchor.verified` rows match that filter too, and every verify
**appends** a `proof.verified` row — so an unfiltered digest drifts on each
verification and a re-check would false-positive `TAMPERED`. Phase 8
restricts the digest to a **closed set of content-establishing actions**
(`proof.created`, `proof.updated`, `proof.file.uploaded`,
`proof.attestation.saved`, `proof.sealed`) — all frozen once a proof is
SEALED. The digest of a sealed proof is therefore permanently stable, which
is what makes recompute-and-compare sound. `computeProofDigestCached` memoizes
it keyed by `(proofId, Proof.updatedAt)` (a sealed proof can't be PATCHed, so
the entry is effectively permanent; any change bumps `updatedAt` and
invalidates it). **Clean cutover**: this changes the digest definition, but
the project has no remote/deployment/production data, so no `digestVersion`
compatibility shim — any proof anchored before this fix should be re-anchored.

### Verification chain format change

The per-proof verification chain's `entryHash` composition gained a `tier`
slot: `sha256(prevHash || proofId || method || result || tier ||
canonical(requesterContext) || createdAt)`. Every pre-Phase-8 row's
`entryHash` is stale until re-stamped — `scripts/backfill-verification-result.ts`
walks every proof's records and recomputes them (plus the per-proof
`VerificationChainCursor` head). Run it once after the migration;
`verifyVerificationChain` reports rows broken until it does.

---

## Notification types

Closed enum — frontend branches on `type` to pick icons and route targets,
so freeform strings would silently break UX. Adding a type is a contract
change.

- `proof_sealed` — emitted on `POST /api/proofs/:id/seal`. Recipient =
  owner. `href = /proofs/:id`. Self-notify is intentionally in today; when
  the frontend wires up richer recipients (org-mates on ORG proofs, case
  collaborators) the recipient set expands here.
- `evidence_package_requested` — emitted on `POST /api/cases/:id/packages`.
  Recipient = **case owner** (regardless of who initiated). `href =
  /cases/:id`. Self-notify is intentional and mirrors `proof_sealed`:
  package builds are async, so a notification is the only consistent
  signal that work is in flight.
- `evidence_package_ready` — emitted by `lib/jobs/build-package.ts` on
  successful upload of the zip to S3. Recipient = **case owner**. `href
  = /cases/:id`. Closes the loop opened by `evidence_package_requested`.
  Failures emit no notification — the package row's status flips to
  FAILED and a successful retry will replay the signal.

Additions must update this list **and** the `NotificationType` union in
`lib/notifications.ts`. Like audit actions, these are a versioned contract.

---

## Cookies & CORS

Cookie attributes (`lib/cookies.ts`):

| Env | `sameSite` | `secure` | Reason |
| --- | --- | --- | --- |
| dev | `lax` | `false` | Local HTTP. Frontend uses Next rewrites (below) so it's same-origin → cookies attach without CORS dance. |
| prod | `none` | `true` | Cross-origin (`api.iproofnow.com` ↔ `app.iproofnow.com`) requires `SameSite=None; Secure` for browsers to send the cookie at all. |

CORS middleware (`middleware.ts`):

- Allowlist: `http://localhost:3000` plus any origins listed in
  `FRONTEND_ORIGIN` (comma-separated).
- `credentials: true`, methods `GET,POST,PATCH,DELETE,OPTIONS`,
  headers `Content-Type,Authorization`. `Vary: Origin` set on every response.

### Local dev: Next rewrites in the FRONTEND repo

To skip CORS in dev entirely (recommended), add to the **frontend's**
`next.config.mjs`:

```js
async rewrites() {
  return [
    { source: '/api/:path*', destination: 'http://localhost:3001/api/:path*' },
  ];
}
```

Frontend thinks it's same-origin → cookies just work → CORS middleware
exists but never fires in dev. In prod the domains split and CORS kicks in.

If you ever see "login returns 200 but `/me` returns 401 and devtools shows
no `Cookie:` header going out", it's almost always one of:

1. `credentials: 'include'` missing on the frontend `fetch` (already correct
   in `lib/store/auth-store.ts`)
2. `sameSite: 'lax'` with cross-origin (needs `none + secure`, which needs
   HTTPS → use the rewrite above instead)
3. `domain` set on the cookie in dev (don't set it in dev)

---

## Audit rules

**Phase 1 audited actions**:

- `auth.login.success`
- `auth.login.failure`
- `auth.logout`
- `auth.session.expired` (reserved — emit when session validation deletes an
  expired row)

**Phase 2 audited actions**:

- `proof.created` — state change on POST /api/proofs
- `proof.updated` — state change on PATCH; `meta.fields` lists touched keys
- `proof.file.uploaded` — state change; `meta` carries fileId, mimeType, size, originalName
- `proof.attestation.saved` — state change (covers both create + update since attestation is upsert)
- `proof.sealed` — state change on POST /seal; `meta.sealedAt`
- `proof.hidden.listed` — **sensitive read** — emitted when the owner pulls `?scope=hidden` on `/api/proofs` or `/api/vault` (vault sets `meta.via = 'vault'`)

Explicitly **not** audited in Phase 2: GET list (default scope), GET detail
on own proof, GET detail on org-visible proof, GET /files list (same access
check as detail).

**Phase 3 audited actions**:

- `proof.hidden.revealed` — **sensitive read** — POST /api/vault/:id/reveal; `meta.reason` (closed enum) + optional `meta.reasonText` (when reason='other') + `meta.hiddenVaultMode` (whether the proof is actually hidden — reveal works on non-hidden proofs too, for consistency)
- `proof.verified` — **sensitive read when proof non-public** — POST /api/proofs/:id/verify; `meta.method`, `meta.result`, `meta.visibility`, `meta.anonymous` (true when no session)
- `audit.queried` — **sensitive read** — GET /api/audit itself; `meta.filterKeys[]` (keys applied, not values), `meta.scope` ('self'|'all')

Explicitly **not** audited in Phase 3: GET /api/vault (default scope),
GET /api/notifications, notification PATCH, notification read-all,
GET /api/proofs/:id/verifications (metadata read — the underlying
proof's access check already gates it).

**Phase 4 audited actions**:

- `case.created` — state change on POST /api/cases; `meta.orgId`
- `case.updated` — state change on PATCH; `meta.fields` lists touched keys (no values)
- `case.proof.linked` — state change; **one row per added proof** with `meta.proofId`. Skipped duplicates do not audit.
- `case.proof.unlinked` — state change; `meta.proofId`
- `package.requested` — state change on POST /api/cases/:id/packages; `meta.packageType`, `meta.caseId`
- `case.detail.viewed` — **reserved**, not emitted in Phase 4. Reserved for the future share-grant code path: a non-owner gaining read access via an explicit grant should audit. Owner / same-org reads stay routine.

Explicitly **not** audited in Phase 4: GET /api/cases (any scope),
GET /api/cases/:id (owner / same-org), GET /api/cases/:id/packages,
GET /api/packages/:id.

**Phase 5 audited actions**:

- `proof.exported` — **sensitive read** on GET /api/proofs/:id/export; `meta.fileCount`, `meta.hasAttestation`, `meta.anchored` (enough for a reviewer to know what left the system without dumping the payload itself).
- `job.failed` — **internal-only**, fire-and-log: emitted by `lib/jobs.ts` when a Job hits its terminal failure (3rd attempt). `entityType='Job'`, `entityId=jobId`, `meta.type` (the job type), `meta.attempts`, `meta.error` (truncated to 1KB). Lets ops see "type X dies on attempt 3" without scraping logs. The handlers themselves don't write `job.failed` — the runner owns it.
- `auth.login.failure` (extended) — now also emitted with `meta.reason='rate_limited'` when the IP-token-bucket gate rejects a login before argon2 verify; `meta.ipKey` carries the bucket key so ops can correlate without scraping middleware logs.

Explicitly **not** audited in Phase 5: GET /api/proofs/:id (owner / same-org),
job retries that aren't terminal (intermediate `RUNNING → PENDING` cycles),
successful job COMPLETE transitions (the handlers' state changes — package
ready, file hashed, proof anchored — are observable through their own
domain rows / notifications).

**Phase 6 audited actions**:

- `audit.chain.verified` — **operator action** on GET /api/audit/verify. ADMIN-only. `entityType='AuditLog'`, `entityId='chain'`, `meta.ok`, `meta.count`, `meta.since?` (when bounded), `meta.brokenAt`/`meta.reason` on failure. The verify endpoint's own audit row chains forward, so a clean verify is the strongest possible attestation: every prior row's hash + signature checked AND the chain head was still consistent at the moment of verification.

Explicitly **not** audited in Phase 6: chain-internal recomputes (the
verifier doesn't audit per-row checks, only the verify call as a whole),
backfill script execution (it's a one-shot ops tool — execution is logged
to stdout, not the chain).

**Phase 7 audited actions**:

- `proof.anchor.verified` — **sensitive read** on GET /api/proofs/:id/anchor/verify; `entityType='Proof'`, `meta.status` (the `AnchorStatus`), `meta.confirmed` (whether a Bitcoin attestation was found, live).

Explicitly **not** audited in Phase 7: OTS calendar submit/upgrade
round-trips (high-volume — ~9 per anchored proof over a week; the
`ProofAnchor` row's `status` transitions are the source of truth, and
chain-writing them would bloat the global audit chain — see "Why OTS
round-trips are not audited"). Job-internal `proof.anchor` /
`proof.anchor.upgrade` lifecycle is observable through `ProofAnchor` +
the existing `job.failed` audit on terminal failure.

**Phase 8 audited actions**: no new action — `proof.verified` (Phase 3)
now carries the real outcome in its meta: `meta.result` (the
`VerificationResult`) and `meta.tier` (the `VerificationTier` or null).
It fires for every verify, anonymous PUBLIC ones included, so a
`TAMPERED` finding always lands in the audit chain.

**Rule for later phases**: audit **state changes** and **sensitive reads**.
Skip routine reads.

| Audit | Skip |
| --- | --- |
| Hidden vault reveals | `/me`, `/session` |
| Proof downloads | `/dashboard` |
| Evidence package access | List vault (own scope) |
| Case detail by non-owner | View own proof |
| Proof seal / update / delete | Notification list reads |

Auditing routine reads drowns the table and adds nothing investigable.

---

## Local dev

Prerequisites: **Node 20**, **pnpm** (`corepack enable`), and either Docker
Desktop OR the user's existing local PostgreSQL 16 (password `proof123`).

```bash
# 1. Install deps
pnpm install

# 2. Start Postgres + MinIO (skip if using local Postgres 16)
docker compose up -d postgres minio minio-init

# 3. Configure env
cp .env.example .env
#    edit DATABASE_URL if using local Postgres 16 instead of Docker

# 4. Apply schema + seed
pnpm prisma migrate dev --name init
pnpm prisma:seed

# 5. Run the API
pnpm dev          # listens on :3001

# 6. Tests (uses DATABASE_URL_TEST → iproofnow_test)
createdb iproofnow_test    # if using local PG; docker-compose creates it via scripts/postgres-init/
pnpm test
```

**Seed credentials** (dev only — `seed.ts` refuses to run when
`NODE_ENV=production`):

```
individual@iproofnow.dev      / dev-password-123
company@iproofnow.dev         / dev-password-123
lawyer@iproofnow.dev          / dev-password-123
law-enforcement@iproofnow.dev / dev-password-123
government@iproofnow.dev      / dev-password-123
admin@iproofnow.dev           / dev-password-123
```

---

## Frontend reference copy

The user's frontend zip is extracted at `C:\IproofNow-frontend\`
(sibling, **not nested** in this repo).

- It's there for **API contract alignment only** — read it to confirm
  request/response shapes that the frontend actually sends/reads.
- **Never import from it.** This is two repos, not a monorepo. If you find
  yourself reaching across for types, stop and define them locally.
- Notable contract pins discovered:
  - `lib/store/auth-store.ts:73` calls `GET /api/auth/session` → we ship
    both `/me` and `/session` (same handler family).
  - `auth-store.ts:117` reads `data.user` directly on login response → no
    `{ success, data: { user } }` wrapping.
  - `lib/types.ts:7` uses lowercase role strings → enforced by
    `roleToFrontend()`.

---

## Phase status

- [x] **Phase 0 — Foundation**: scaffold, docker-compose, Prisma schema (13
      entities), `lib/{db,logger,errors,audit,session,cookies,password,
      serializers,guards}`, CORS middleware.
- [x] **Phase 1 — Auth + Dashboard**: `/api/auth/{login,logout,me,session}`,
      `/api/dashboard`, vitest integration tests, `prisma/seed.ts` (6
      users).
- [x] **Phase 2 — Proofs + Files + Attestation + Seal**: `/api/proofs` CRUD,
      `/api/proofs/[id]/files` multipart upload to MinIO + presigned
      `downloadUrl`, `/api/proofs/[id]/attestation` upsert,
      `/api/proofs/[id]/seal` with accumulated `details.reasons[]`.
      `Proof.roleContext` + `ProofFile.hashStatus` schema additions.
      `lib/{storage,proof-serializers,proof-guards}`. Hidden-vault
      404-on-non-owner invariant enforced. `proof.hidden.listed` audits
      sensitive reads.
- [x] **Phase 3 — Vault + Verify + Notifications + Audit**: `/api/vault`
      (owner-scoped with `q`, filters, sort, `hasFiles`/`hasAttestation`),
      `/api/vault/[id]/reveal` (audited hidden-vault reveal with closed
      reason set), `/api/proofs/[id]/verify` (public for PUBLIC proofs,
      Phase 3 always 'verified'), `/api/proofs/[id]/verifications`
      (history + counts), `/api/notifications` (list + mark-read +
      read-all), `/api/audit` (actor-scoped; ADMIN sees all).
      `lib/proof-search.ts` + `lib/notifications.ts` + `loadProofForVerify`.
      New audit actions: `proof.hidden.revealed`, `proof.verified`,
      `audit.queried`. `NotificationType = 'proof_sealed'` (closed enum).
      Seal now emits a `proof_sealed` notification to the owner.
- [x] **Phase 4 — Cases + Case↔Proof + Evidence Packages**: `/api/cases`
      CRUD (owned ∪ same-org list with `q`+`status`, owner-only PATCH),
      `/api/cases/[id]/proofs` atomic batch link / unlink (one foreign id
      rolls back the whole batch), `/api/cases/[id]/packages` request
      stub (PENDING row + 202; worker is Phase 5) + list,
      `/api/packages/[id]` detail with `downloadUrl` only when READY.
      `lib/{case-guards,case-serializers,case-search}`. New audit actions:
      `case.created`, `case.updated`, `case.proof.linked`,
      `case.proof.unlinked`, `package.requested`. `case.detail.viewed`
      reserved (TODO stub) for the future share-grant flow.
      `NotificationType += 'evidence_package_requested'` (recipient =
      case owner, regardless of who initiated).
- [x] **Phase 5 — Background jobs + Hardening + Exports**: `lib/jobs.ts`
      (FOR UPDATE SKIP LOCKED claim, retry+backoff, terminal `job.failed`
      audit), three handlers — `proof_file.hash` (fills `ProofFile.fileHash`
      + flips `hashStatus`), `evidence_package.build` (archiver-based zip
      builder; manifest.json + per-proof files; flips package READY +
      notifies owner), `proof.anchor` (Phase 5 STUB writing deterministic
      `sha256(proofId)` to `ProofAnchor`; Phase 7 swaps in real OTS).
      Seal/upload/package-request handlers all enqueue inside their own
      transactions so state-change ↔ job-row stays atomic. New endpoint
      `GET /api/proofs/[id]/export` (audited as `proof.exported`).
      Hardening: login-IP token bucket + 100MB body cap in middleware +
      `lib/user-email.ts` normalization helper + `TooManyRequestsError`
      (429). Schema additions: `Job` model + `JobStatus` enum + `ProofAnchor`
      model. `NotificationType += 'evidence_package_ready'`. New audit
      actions: `proof.exported`, `job.failed`, plus rate-limited login
      audited via existing `auth.login.failure` with `meta.reason='rate_limited'`.
- [x] **Phase 6 — Verification chain hardening + audit immutability +
      KMS-style signed audit entries**: AuditLog rows are now linked into
      a tamper-evident hash chain via `lib/audit.ts → appendAudit` (every
      Phase 1–5 emit site keeps using `writeAudit` and gains chaining for
      free through the passthrough). `prevHash`/`entryHash` columns +
      `signature String?` (HMAC-SHA-256 under `AUDIT_SIGNING_KEY`). The
      chain serializes through `AuditChainCursor` (`SELECT … FOR UPDATE`
      on a single global row); per-proof verification chains use their
      own `VerificationChainCursor` keyed by proofId so heavy-traffic
      proofs serialize against themselves only. New endpoint
      `GET /api/audit/verify` (ADMIN-only) walks the chain, recomputes
      every entryHash, checks signatures, and self-emits
      `audit.chain.verified`. `lib/audit-sig.ts` is the KMS shim — swap
      this one file for a real KMS later, no call-site rewrites. BEFORE
      UPDATE trigger on AuditLog rejects edits to `proof.hidden.revealed`
      rows < 24h old (declarative defense in depth). Hardening: strict
      CSP + nosniff + Referrer-Policy headers in `next.config.mjs`;
      `RateLimiter` interface extracted in `lib/rate-limit.ts` so the
      Redis swap is a new file, not call-site changes; `cookies.ts` TODO
      flagged for the future share-grant privilege-rotation hook.
      Backfill: `scripts/backfill-audit-chain.ts` (idempotent, refuses
      prod without `--allow-prod`). New audit actions:
      `audit.chain.verified`. New env var: `AUDIT_SIGNING_KEY` (64 hex,
      module-load fail-fast outside `NODE_ENV=test`).
- [x] **Phase 7 — Real OpenTimestamps anchoring**: replaced the Phase 5
      anchor stub with a two-phase OTS flow. `proof.anchor`
      (`lib/jobs/anchor.ts`) computes the proof content digest
      (`lib/ots/proof-digest.ts` — chained audit entryHashes + file hashes
      + attestation), submits it to the Bitcoin calendars in parallel with
      bounded timeouts, writes `ProofAnchor` at `PENDING` with
      `contentHash`, and enqueues `proof.anchor.upgrade`. The upgrade
      handler (`lib/jobs/anchor-upgrade.ts`) polls on a backoff schedule
      until a Bitcoin block attestation appears (→ `CONFIRMED` with
      block height/hash) or the ~7-day cap is hit (→ `FAILED` via
      `TerminalJobError`). All `opentimestamps` library use is isolated in
      `lib/ots/client.ts` (+ `types/opentimestamps.d.ts` shim). New
      endpoint `GET /api/proofs/[id]/anchor/verify` (audited
      `proof.anchor.verified`) re-checks the anchor against a calendar +
      block explorer without trusting the DB; `/export` gained anchor
      fields + `verifyUrl`. Schema: `AnchorStatus` enum + `ProofAnchor`
      `contentHash`/`bitcoinBlockHeight`/`bitcoinBlockHash`/`confirmedAt`/
      `upgradedAt`. `lib/jobs.ts` gained `TerminalJobError`. New env vars:
      `OTS_CALENDAR_URLS`, `BITCOIN_EXPLORER_URL`. Backfill:
      `scripts/backfill-anchor-status.ts` (gates the enum migration).
      `next.config.mjs` marks `opentimestamps` + `@node-rs/argon2` as
      `serverComponentsExternalPackages` so the production build resolves
      their native / broken-`main` packages.
- [x] **Phase 8 — Verification result enrichment**: `POST /verify` returns
      a real result instead of the Phase 3 always-`'verified'` placeholder.
      `lib/proof-verification.ts → evaluateProof` recomputes the proof
      content digest and compares it to `ProofAnchor.contentHash`, yielding
      `VERIFIED` / `TAMPERED` / `NOT_FOUND` / `INDETERMINATE` (closed
      `VerificationResult` enum) plus a `VerificationTier`
      (`HASH_VERIFIED`, or `CRYPTOGRAPHICALLY_VERIFIED` for a
      Bitcoin-`CONFIRMED` anchor). Required correctness fix:
      `computeProofDigest` now filters `AuditLog` to content-establishing
      actions so the digest is time-stable (an unfiltered digest drifted
      every verify and would false-positive `TAMPERED`); a
      `(proofId,updatedAt)` memo cache backs the per-verify recompute.
      The verification-chain `entryHash` composition gained a `tier` slot;
      `scripts/backfill-verification-result.ts` re-stamps existing chains.
      `GET /verifications` reports enum counts + a `tiers` breakdown.
      Schema: `VerificationResult` + `VerificationTier` enums,
      `VerificationRecord.result` → enum, `+ tier`. `proof.verified` audit
      meta gains `result` + `tier`.
- [ ] Phase 9+ — Evidence package signing: detached signatures over
      `EvidencePackage` zips so a court bundle is verifiable offline,
      independent of iProofNow infrastructure.
