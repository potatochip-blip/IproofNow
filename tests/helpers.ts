import {
  PrismaClient,
  type Case,
  type CaseProof,
  type EvidencePackage,
  type Notification,
  type Organization,
  type PackageStatus,
  type Proof,
  type Role,
  type User,
  type VerificationRecord,
} from '@prisma/client';
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

/** Wipe all rows between tests. Order matters: child tables first. */
export async function truncateAll(): Promise<void> {
  const p = db();
  await p.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog","VerificationRecord","CaseProof","EvidencePackage",
      "ProofAttestation","ProofFile","PreservationConfig","Notification",
      "Proof","Case","Session","Organization","User"
    RESTART IDENTITY CASCADE;
  `);
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
  overrides: Partial<{ method: string; result: string }> = {}
): Promise<VerificationRecord> {
  return db().verificationRecord.create({
    data: {
      proofId,
      method: overrides.method ?? 'hash',
      result: overrides.result ?? 'verified',
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
