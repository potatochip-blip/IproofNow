import { createHash } from 'node:crypto';
import {
  PrismaClient,
  type AnchorStatus,
  type Case,
  type CaseProof,
  type EvidencePackage,
  type HashStatus,
  type Notification,
  type Organization,
  type PackageStatus,
  type Proof,
  type ProofAnchor,
  type ProofFile,
  type Role,
  type User,
  type VerificationRecord,
  type VerificationResult,
  type VerificationTier,
} from '@prisma/client';
import { buildStoredOtsProof } from './ots-stub';
import { hashPassword } from '@/lib/password';
import { createSession, generateSessionToken } from '@/lib/session';
import { seedCookie } from './cookie-jar';
import { SESSION_COOKIE_NAME } from '@/lib/cookies';

// One client for all tests — vitest forks isolate between files but share
// inside a file. singleFork in vitest.config.ts keeps DB ops linear.
let prisma: PrismaClient | undefined;
export function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

/** Wipe all rows between tests. Order matters: child tables first.
 *  AuditChainCursor stays — it's a single-row global lock target that the
 *  Phase 6 chain helpers SELECT FOR UPDATE; we reset its head hash instead.
 *  VerificationChainCursor cascades when its Proof is dropped.
 */
export async function truncateAll(): Promise<void> {
  const p = db();
  await p.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog","VerificationRecord","VerificationChainCursor","CaseProof",
      "EvidencePackage","ProofAttestation","ProofFile","PreservationConfig",
      "ProofAnchor","Notification","Job","Proof","Case","Session",
      "Organization","User"
    RESTART IDENTITY CASCADE;
  `);
  await p.$executeRawUnsafe(
    `UPDATE "AuditChainCursor" SET "lastEntryHash" = NULL WHERE "id" = 'global';`
  );
}

export async function createTestUser(opts: {
  email?: string;
  name?: string;
  role?: Role;
  password?: string;
} = {}): Promise<{ user: User; password: string }> {
  const password = opts.password ?? 'test-password-123';
  const passwordHash = await hashPassword(password);
  const user = await db().user.create({
    data: {
      email: opts.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@iproofnow.dev`,
      name: opts.name ?? 'Test User',
      role: opts.role ?? 'INDIVIDUAL',
      passwordHash,
    },
  });
  return { user, password };
}

/** Create a session for the user and seed the cookie jar so guards see it. */
export async function loginAs(userId: string): Promise<{ token: string; sessionId: string }> {
  const token = generateSessionToken();
  const session = await createSession(token, userId);
  seedCookie(SESSION_COOKIE_NAME, token);
  return { token, sessionId: session.id };
}

/** Build a NextRequest-compatible Request. */
export function buildJsonRequest(
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Build a multipart/form-data request carrying a single "file" field. */
export function buildMultipartRequest(
  url: string,
  fileBytes: Uint8Array,
  filename: string,
  mimeType: string
): Request {
  const form = new FormData();
  // Cast: lib.dom's BlobPart wants Uint8Array<ArrayBuffer> specifically,
  // but @types/node widens our input to Uint8Array<ArrayBufferLike>.
  // Runtime-equivalent — the bytes are the same.
  const blob = new Blob([fileBytes as BlobPart], { type: mimeType });
  form.append('file', blob, filename);
  return new Request(url, { method: 'POST', body: form });
}

/** Create an Organization with an owner. */
export async function createTestOrg(
  ownerUserId: string,
  name = 'Test Org'
): Promise<Organization> {
  return db().organization.create({
    data: { name, type: 'company', ownerUserId },
  });
}

/** Attach an existing user to an org. */
export async function joinOrg(userId: string, orgId: string): Promise<void> {
  await db().user.update({ where: { id: userId }, data: { orgId } });
}

/** Create a draft proof for a user. */
export async function createTestProof(
  ownerUserId: string,
  overrides: Partial<{
    title: string;
    description: string;
    categoryKey: string;
    proofType: string;
    orgId: string | null;
    visibility: 'PRIVATE' | 'PUBLIC' | 'ORG';
    peopleInvolved: string[];
  }> = {}
): Promise<Proof> {
  return db().proof.create({
    data: {
      ownerUserId,
      title: overrides.title ?? 'Test Proof',
      description: overrides.description ?? '',
      categoryKey: overrides.categoryKey ?? 'general',
      proofType: overrides.proofType ?? 'document',
      orgId: overrides.orgId ?? null,
      ...(overrides.visibility ? { visibility: overrides.visibility } : {}),
      ...(overrides.peopleInvolved ? { peopleInvolved: overrides.peopleInvolved } : {}),
    },
  });
}

export async function createTestNotification(
  userId: string,
  overrides: Partial<{
    type: string;
    title: string;
    body: string;
    href: string | null;
    readAt: Date | null;
  }> = {}
): Promise<Notification> {
  return db().notification.create({
    data: {
      userId,
      type: overrides.type ?? 'proof_sealed',
      title: overrides.title ?? 'Test',
      body: overrides.body ?? 'Test body',
      href: overrides.href ?? null,
      readAt: overrides.readAt ?? null,
    },
  });
}

export async function createTestVerification(
  proofId: string,
  overrides: Partial<{
    method: string;
    result: VerificationResult;
    tier: VerificationTier | null;
  }> = {}
): Promise<VerificationRecord> {
  // Phase 6: route inserts through the per-proof chain helper so tests
  // exercise the same code path as production.
  const { appendVerificationRecord } = await import('@/lib/verification-chain');
  return appendVerificationRecord({
    proofId,
    method: overrides.method ?? 'hash',
    result: overrides.result ?? 'VERIFIED',
    tier: overrides.tier ?? null,
  });
}

/** Create a ProofFile row directly (no S3 upload). */
export async function createTestProofFile(
  proofId: string,
  overrides: Partial<{
    originalName: string;
    mimeType: string;
    size: number;
    storagePath: string;
    fileHash: string | null;
    hashStatus: HashStatus;
  }> = {}
): Promise<ProofFile> {
  return db().proofFile.create({
    data: {
      proofId,
      originalName: overrides.originalName ?? 'evidence.pdf',
      mimeType: overrides.mimeType ?? 'application/pdf',
      size: overrides.size ?? 1024,
      storagePath: overrides.storagePath ?? `proofs/${proofId}/evidence.pdf`,
      fileHash:
        overrides.fileHash !== undefined
          ? overrides.fileHash
          : createHash('sha256').update(`${proofId}:file`).digest('hex'),
      hashStatus: overrides.hashStatus ?? 'COMPLETE',
    },
  });
}

/** Create a ProofAnchor row directly with a valid OTS proof. */
export async function createTestAnchor(
  proofId: string,
  overrides: Partial<{
    status: AnchorStatus;
    contentHash: Buffer;
    otsProof: Buffer;
    bitcoinBlockHeight: number | null;
    bitcoinBlockHash: string | null;
    confirmedAt: Date | null;
  }> = {}
): Promise<ProofAnchor> {
  const status = overrides.status ?? 'PENDING';
  const contentHash =
    overrides.contentHash ?? createHash('sha256').update(proofId).digest();
  const confirmed = status === 'CONFIRMED';
  const otsProof =
    overrides.otsProof ??
    buildStoredOtsProof(contentHash, {
      confirmed,
      height: overrides.bitcoinBlockHeight ?? undefined,
    });
  return db().proofAnchor.create({
    data: {
      proofId,
      status,
      contentHash,
      otsProof,
      bitcoinBlockHeight:
        overrides.bitcoinBlockHeight ?? (confirmed ? 800_000 : null),
      bitcoinBlockHash: overrides.bitcoinBlockHash ?? null,
      confirmedAt: overrides.confirmedAt ?? (confirmed ? new Date() : null),
    },
  });
}

export async function createTestCase(
  ownerUserId: string,
  overrides: Partial<{
    title: string;
    description: string;
    status: string;
    orgId: string | null;
  }> = {}
): Promise<Case> {
  return db().case.create({
    data: {
      ownerUserId,
      title: overrides.title ?? 'Test Case',
      description: overrides.description ?? '',
      status: overrides.status ?? 'active',
      orgId: overrides.orgId ?? null,
    },
  });
}

export async function linkCaseProof(
  caseId: string,
  proofId: string
): Promise<CaseProof> {
  return db().caseProof.create({ data: { caseId, proofId } });
}

export async function createTestPackage(
  createdByUserId: string,
  overrides: Partial<{
    caseId: string | null;
    proofId: string | null;
    packageType: string;
    status: PackageStatus;
    storagePath: string | null;
  }> = {}
): Promise<EvidencePackage> {
  return db().evidencePackage.create({
    data: {
      createdByUserId,
      caseId: overrides.caseId ?? null,
      proofId: overrides.proofId ?? null,
      packageType: overrides.packageType ?? 'court_bundle',
      ...(overrides.status ? { status: overrides.status } : {}),
      ...(overrides.storagePath !== undefined
        ? { storagePath: overrides.storagePath }
        : {}),
    },
  });
}
