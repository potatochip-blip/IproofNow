import { createHash } from 'node:crypto';
import { prisma } from './db';
import { logger } from './logger';
import { sign } from './audit-sig';

export type AuditInput = {
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  meta?: Record<string, unknown>;
};

const CURSOR_ID = 'global';

/**
 * Recursive sorted-key JSON stringify. The hash chain compares meta byte-
 * for-byte across recompute, so key ordering must be canonical regardless
 * of how callers built the object literal.
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
 * Compute the entryHash for an audit row. Exported so the verifier and the
 * backfill script use the exact same composition rule as the writer.
 *
 * Composition: sha256(prevHash || actorUserId || entityType || entityId
 *                     || action || canonicalJson(meta) || createdAt iso)
 *
 * Each field is delimited by a NUL byte so distinct field boundaries can't
 * collide via concatenation. Null prevHash / actorUserId are encoded as the
 * empty string.
 */
export function computeEntryHash(input: {
  prevHash: string | null;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  meta: unknown;
  createdAt: Date;
}): string {
  const h = createHash('sha256');
  const parts = [
    input.prevHash ?? '',
    input.actorUserId ?? '',
    input.entityType,
    input.entityId,
    input.action,
    canonicalJson(input.meta ?? {}),
    input.createdAt.toISOString(),
  ];
  h.update(parts.join('\x00'));
  return h.digest('hex');
}

/**
 * Append an audit row to the global tamper-evident chain.
 *
 * Phase 6 — every insert serializes through `SELECT … FOR UPDATE` on the
 * single `AuditChainCursor` row (`id = 'global'`). prevHash is the previous
 * row's entryHash; entryHash is sha256 over the canonical row tuple;
 * signature is HMAC-SHA-256(entryHash) under AUDIT_SIGNING_KEY.
 *
 * The cursor row's `lastEntryHash` mirrors the chain head so the next
 * append doesn't need to scan AuditLog. Both rows update inside the same
 * transaction.
 *
 * Throws on failure — call sites that must not break the user-visible
 * request use `writeAudit` instead.
 */
export async function appendAudit(input: AuditInput): Promise<void> {
  // createdAt is captured here (not relied upon from @default(now()))
  // because the hash is computed from the same value that's persisted.
  const createdAt = new Date();

  await prisma.$transaction(async (tx) => {
    // Lock the global cursor row to serialize chain head reads/writes.
    // Read prevHash from the cursor's mirrored value — cheaper than
    // ordering a full table scan on every append.
    const locked = await tx.$queryRawUnsafe<
      Array<{ lastEntryHash: string | null }>
    >(`SELECT "lastEntryHash" FROM "AuditChainCursor" WHERE "id" = $1 FOR UPDATE`, CURSOR_ID);

    if (locked.length === 0) {
      // First append on a fresh DB where the cursor row wasn't seeded by
      // the migration / global-setup. Insert it now so the FOR UPDATE
      // succeeds on the next call too.
      await tx.$executeRawUnsafe(
        `INSERT INTO "AuditChainCursor" ("id", "updatedAt") VALUES ($1, NOW())
         ON CONFLICT DO NOTHING`,
        CURSOR_ID
      );
    }

    const prevHash = locked[0]?.lastEntryHash ?? null;
    const meta = input.meta ?? {};
    const entryHash = computeEntryHash({
      prevHash,
      actorUserId: input.actorUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      meta,
      createdAt,
    });
    const signature = sign(entryHash);

    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        meta: meta as object,
        prevHash,
        entryHash,
        signature,
        createdAt,
      },
    });

    await tx.$executeRawUnsafe(
      `UPDATE "AuditChainCursor"
         SET "lastEntryHash" = $1, "updatedAt" = NOW()
       WHERE "id" = $2`,
      entryHash,
      CURSOR_ID
    );
  });
}

/**
 * Best-effort audit write. Wraps `appendAudit` with the historical
 * "never throw" contract — failures are logged but don't propagate.
 *
 * Every Phase 1–5 audit emit site already calls writeAudit and gains
 * chain participation transparently via this passthrough.
 *
 * Audited actions, by phase (see CLAUDE.md for the full table):
 *   Phase 1: auth.login.{success,failure} | auth.logout | auth.session.expired
 *   Phase 2: proof.{created,updated,sealed,file.uploaded,attestation.saved,hidden.listed}
 *   Phase 3: proof.{hidden.revealed,verified} | audit.queried
 *   Phase 4: case.{created,updated,proof.linked,proof.unlinked} | package.requested
 *   Phase 5: proof.exported | job.failed
 *   Phase 6: audit.chain.verified
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await appendAudit(input);
  } catch (err) {
    logger.error('audit.write_failed', {
      err: err instanceof Error ? err.message : String(err),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
    });
  }
}
