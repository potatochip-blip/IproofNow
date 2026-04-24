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
lib/
  db.ts                      # Prisma client singleton
  session.ts                 # generateSessionToken, createSession, validate (sliding refresh), invalidate*
  cookies.ts                 # session cookie set/clear/read
  password.ts                # argon2id hash/verify
  serializers.ts             # Role/Tier enum ↔ frontend casing, serializeUser()
  guards.ts                  # getCurrentSession, requireSession, requireRole(...roles)
  errors.ts                  # ApiError + typed subclasses + errorResponse()
  audit.ts                   # writeAudit() — fire-and-log, never throws
  logger.ts                  # JSON line logger
middleware.ts                # CORS for /api/* (allowlist + credentials)
prisma/
  schema.prisma              # 13 entities + 5 enums
  seed.ts                    # 6 users (one per role); refuses to run in production
tests/
  global-setup.ts            # prisma db push --force-reset against *_test DB
  test-env.ts                # mocks next/headers cookies(); pins NODE_ENV=test
  cookie-jar.ts              # in-memory jar that quacks like cookies()
  helpers.ts                 # truncateAll, createTestUser, loginAs, buildJsonRequest
  auth.test.ts dashboard.test.ts
docker-compose.yml           # postgres:16-alpine + minio + minio-init bucket creator
.env.example                 # all required env vars; DATABASE_URL_TEST must end in _test
```

---

## Entity summary (13 models)

`User`, `Organization`, `Session`, `Proof`, `ProofFile`, `ProofAttestation`,
`VerificationRecord`, `Notification`, `Case`, `CaseProof`, `EvidencePackage`,
`AuditLog`, `PreservationConfig`.

Enums: `Role` (INDIVIDUAL|COMPANY|LAWYER|LAW_ENFORCEMENT|GOVERNMENT|ADMIN),
`ProofStatus` (DRAFT|SEALED), `Visibility` (PRIVATE|PUBLIC|ORG),
`PackageStatus` (PENDING|READY|FAILED), `SubscriptionTier`
(FREE|PRO|BUSINESS|ENTERPRISE).

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

**Phase 1 audited actions** (only):

- `auth.login.success`
- `auth.login.failure`
- `auth.logout`
- `auth.session.expired` (reserved — emit when session validation deletes an
  expired row)

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
- [ ] Phase 2 — Proofs (create/update/detail, file upload to MinIO,
      attestation, seal).
- [ ] Phase 3 — Vault, verification, notifications, audit query.
- [ ] Phase 4 — Cases, evidence packages, exports.
- [ ] Phase 5+ — Background jobs, OpenTimestamps batching, hardening.
