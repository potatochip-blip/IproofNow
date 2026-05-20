import { createHash } from 'node:crypto';
import type {
  VerificationRecord,
  VerificationResult,
  VerificationTier,
} from '@prisma/client';
import { prisma } from './db';

export type AppendVerificationInput = {
  proofId: string;
  method: string;
  result: VerificationResult;
  /** Strength tier — set only for a VERIFIED result, null otherwise. */
  tier?: VerificationTier | null;
  requesterContext?: Record<string, unknown>;
};

/**
 * Recursive sorted-key JSON stringify — mirrors lib/audit.ts's canonical
 * encoding. Kept private here so the verification chain can evolve its
 * canonicalization independently if ever needed.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * Compute the entryHash for a VerificationRecord row. Exported so the
 * verifier and the backfill use the exact same composition rule as the
 * writer.
 *
 * Composition (Phase 8): sha256(prevHash || proofId || method || result
 *   || tier || canonicalJson(requesterContext) || createdAt iso)
 *
 * Fields are NUL-delimited so distinct values can't collide via
 * concatenation. Null prevHash / null tier encode as the empty string.
 *
 * The `tier` slot is a Phase 8 addition — it changed the chain format, so
 * every pre-Phase-8 row's entryHash is stale until re-stamped by
 * scripts/backfill-verification-result.ts.
 */
export function computeVerificationEntryHash(input: {
  prevHash: string | null;
  proofId: string;
  method: string;
  result: string;
  tier: string | null;
  requesterContext: unknown;
  createdAt: Date;
}): string {
  const h = createHash('sha256');
  const parts = [
    input.prevHash ?? '',
    input.proofId,
    input.method,
    input.result,
    input.tier ?? '',
    canonicalJson(input.requesterContext ?? {}),
    input.createdAt.toISOString(),
  ];
  h.update(parts.join('\x00'));
  return h.digest('hex');
}

/**
 * Append a VerificationRecord to its proof's per-proof hash chain.
 *
 * Phase 6 — each proof has its own VerificationChainCursor row. Appends
 * serialize via SELECT … FOR UPDATE on that row, so heavy-traffic proofs
 * serialize against themselves only, never against unrelated proofs. The
 * cursor is created lazily on first verify (`ON CONFLICT DO NOTHING`),
 * then re-locked for the chain head read.
 *
 * Note: there's no signature column on VerificationRecord — the chain
 * itself plus the audit-row pair (`proof.verified` audit references the
 * record id) gives tamper detection. Add HMAC if a future threat model
 * justifies it.
 */
export async function appendVerificationRecord(
  input: AppendVerificationInput
): Promise<VerificationRecord> {
  const createdAt = new Date();
  const requesterContext = input.requesterContext ?? {};
  const tier = input.tier ?? null;

  return prisma.$transaction(async (tx) => {
    // Lazy-create the cursor row if this is the first verify for the proof.
    // ON CONFLICT keeps it idempotent under concurrent first-attempts.
    await tx.$executeRawUnsafe(
      `INSERT INTO "VerificationChainCursor" ("proofId", "updatedAt")
       VALUES ($1, NOW())
       ON CONFLICT ("proofId") DO NOTHING`,
      input.proofId
    );

    const locked = await tx.$queryRawUnsafe<
      Array<{ lastEntryHash: string | null }>
    >(
      `SELECT "lastEntryHash" FROM "VerificationChainCursor"
       WHERE "proofId" = $1 FOR UPDATE`,
      input.proofId
    );

    const prevHash = locked[0]?.lastEntryHash ?? null;
    const entryHash = computeVerificationEntryHash({
      prevHash,
      proofId: input.proofId,
      method: input.method,
      result: input.result,
      tier,
      requesterContext,
      createdAt,
    });

    const record = await tx.verificationRecord.create({
      data: {
        proofId: input.proofId,
        method: input.method,
        result: input.result,
        tier,
        requesterContext: requesterContext as object,
        prevHash,
        entryHash,
        createdAt,
      },
    });

    await tx.$executeRawUnsafe(
      `UPDATE "VerificationChainCursor"
         SET "lastEntryHash" = $1, "updatedAt" = NOW()
       WHERE "proofId" = $2`,
      entryHash,
      input.proofId
    );

    return record;
  });
}

export type VChainOk = { ok: true; count: number };
export type VChainBroken = {
  ok: false;
  brokenAt: string;
  reason: 'hash_mismatch' | 'broken_link';
  expected?: string;
  actual?: string;
};
export type VChainResult = VChainOk | VChainBroken;

/**
 * Verify the per-proof verification record chain. Walks createdAt asc for
 * a single proofId, recomputes each entryHash, returns the first failure
 * point or { ok: true, count }.
 */
export async function verifyVerificationChain(
  proofId: string
): Promise<VChainResult> {
  const rows = await prisma.verificationRecord.findMany({
    where: { proofId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  let prevHash: string | null = null;
  let count = 0;

  for (const row of rows) {
    if (row.entryHash === '') {
      return {
        ok: false,
        brokenAt: row.id,
        reason: 'broken_link',
        expected: 'non-empty entryHash',
        actual: '(empty)',
      };
    }

    if (row.prevHash !== prevHash) {
      return {
        ok: false,
        brokenAt: row.id,
        reason: 'broken_link',
        expected: prevHash ?? '(null)',
        actual: row.prevHash ?? '(null)',
      };
    }

    const recomputed = computeVerificationEntryHash({
      prevHash: row.prevHash,
      proofId: row.proofId,
      method: row.method,
      result: row.result,
      tier: row.tier,
      requesterContext: row.requesterContext,
      createdAt: row.createdAt,
    });
    if (recomputed !== row.entryHash) {
      return {
        ok: false,
        brokenAt: row.id,
        reason: 'hash_mismatch',
        expected: recomputed,
        actual: row.entryHash,
      };
    }

    prevHash = row.entryHash;
    count += 1;
  }

  return { ok: true, count };
}
