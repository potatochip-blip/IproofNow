import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { computeEntryHash } from './audit';
import { verify as verifySignature } from './audit-sig';

export type ChainOk = { ok: true; count: number };
export type ChainBroken = {
  ok: false;
  brokenAt: string;
  reason: 'hash_mismatch' | 'signature_mismatch' | 'broken_link';
  expected?: string;
  actual?: string;
};
export type ChainResult = ChainOk | ChainBroken;

const PAGE_SIZE = 500;

/**
 * Walk the AuditLog chain in createdAt asc, recompute each row's
 * entryHash, and verify it matches what's persisted. Optionally bound
 * the walk with `since` — but we still load the row immediately preceding
 * `since` so the prevHash link can be checked (otherwise a truncation
 * attack would falsely greenlight the truncated suffix).
 *
 * Pagination uses a (createdAt, id) cursor so the walk is O(N) regardless
 * of table size.
 *
 * Phase 7+ idea: streaming verification with periodic checkpoints exposed
 * via a separate `lastVerifiedHash` column so we don't re-walk the whole
 * chain on every check. Out of scope today — current write volume doesn't
 * justify the bookkeeping.
 */
export async function verifyAuditChain(
  opts: { since?: Date } = {}
): Promise<ChainResult> {
  let prevHash: string | null = null;
  let count = 0;
  let cursor: { createdAt: Date; id: string } | null = null;

  // If `since` is set, find the latest row strictly before `since` so we
  // can seed prevHash correctly. Without this seed, truncation at a known
  // point would silently verify.
  if (opts.since) {
    const seed = await prisma.auditLog.findFirst({
      where: { createdAt: { lt: opts.since } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { entryHash: true },
    });
    prevHash = seed?.entryHash ?? null;
  }

  for (;;) {
    const where: Prisma.AuditLogWhereInput = cursor
      ? {
          AND: [
            opts.since ? { createdAt: { gte: opts.since } } : {},
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                {
                  AND: [
                    { createdAt: cursor.createdAt },
                    { id: { gt: cursor.id } },
                  ],
                },
              ],
            },
          ],
        }
      : opts.since
      ? { createdAt: { gte: opts.since } }
      : {};

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      // Pre-Phase-6 row that was never backfilled: surface as broken_link.
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

      const recomputed = computeEntryHash({
        prevHash: row.prevHash,
        actorUserId: row.actorUserId,
        entityType: row.entityType,
        entityId: row.entityId,
        action: row.action,
        meta: row.meta,
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

      // Signature is optional for now — null means "pre-signing-rollout";
      // when present it must verify.
      if (row.signature !== null && !verifySignature(row.entryHash, row.signature)) {
        return {
          ok: false,
          brokenAt: row.id,
          reason: 'signature_mismatch',
          expected: '(valid HMAC)',
          actual: row.signature,
        };
      }

      prevHash = row.entryHash;
      count += 1;
    }

    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (rows.length < PAGE_SIZE) break;
  }

  return { ok: true, count };
}
