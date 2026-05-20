/**
 * Phase 6 one-shot — backfill prevHash / entryHash / signature on every
 * existing AuditLog row, plus prevHash / entryHash on every existing
 * VerificationRecord row.
 *
 * Run after deploying the Phase 6 migration but before relying on chain
 * verification. Idempotent: rows that already have a non-empty entryHash
 * are skipped, so re-running picks up wherever a previous run stopped.
 *
 * Ordering: createdAt asc, id asc as a tiebreaker. Cuid is k-sortable, so
 * id asc on ties yields a deterministic chain regardless of how the rows
 * landed in the table physically.
 *
 * The hidden-reveal immutability trigger blocks UPDATEs on rows where
 * action='proof.hidden.revealed' and createdAt is within the last 24h.
 * Backfilling those rows requires `session_replication_role = replica`
 * inside the transaction, which suppresses non-RI triggers for the
 * duration. We scope it to the smallest unit (per row) to minimize the
 * window where the trigger is suppressed.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-audit-chain.ts            # dev / staging
 *   pnpm tsx scripts/backfill-audit-chain.ts --allow-prod   # prod
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { computeEntryHash } from '../lib/audit';
import { sign } from '../lib/audit-sig';
import { computeVerificationEntryHash } from '../lib/verification-chain';

const PAGE = 500;
const CURSOR_ID = 'global';

async function main() {
  const allowProd = process.argv.includes('--allow-prod');
  if (process.env.NODE_ENV === 'production' && !allowProd) {
    throw new Error(
      'Refusing to run in production without --allow-prod. ' +
        'Take a backup first; the script rewrites prevHash/entryHash/signature.'
    );
  }

  const prisma = new PrismaClient();
  try {
    await backfillAuditChain(prisma);
    await backfillVerificationChains(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function backfillAuditChain(prisma: PrismaClient): Promise<void> {
  // Ensure the cursor row exists.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AuditChainCursor" ("id", "updatedAt") VALUES ($1, NOW())
     ON CONFLICT DO NOTHING`,
    CURSOR_ID
  );

  // Load the last stamped entryHash to support resumable runs.
  const head = await prisma.$queryRawUnsafe<Array<{ entryHash: string | null }>>(
    `SELECT "entryHash" FROM "AuditLog"
       WHERE "entryHash" <> ''
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT 1`
  );
  let prevHash: string | null = head[0]?.entryHash ?? null;
  let stamped = 0;
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    const where: Prisma.AuditLogWhereInput = {
      entryHash: '',
      ...(cursor
        ? {
            OR: [
              { createdAt: { gt: cursor.createdAt } },
              {
                AND: [
                  { createdAt: cursor.createdAt },
                  { id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const entryHash = computeEntryHash({
        prevHash,
        actorUserId: row.actorUserId,
        entityType: row.entityType,
        entityId: row.entityId,
        action: row.action,
        meta: row.meta,
        createdAt: row.createdAt,
      });
      const signature = sign(entryHash);

      // The reveal-immutability trigger blocks UPDATEs on recent
      // proof.hidden.revealed rows. Suppress non-RI triggers for the
      // single statement that touches them; other rows go through a
      // normal UPDATE.
      const needsBypass =
        row.action === 'proof.hidden.revealed' &&
        Date.now() - row.createdAt.getTime() < 24 * 60 * 60 * 1000;

      if (needsBypass) {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
          await tx.$executeRawUnsafe(
            `UPDATE "AuditLog" SET "prevHash" = $1, "entryHash" = $2, "signature" = $3 WHERE "id" = $4`,
            prevHash,
            entryHash,
            signature,
            row.id
          );
        });
      } else {
        await prisma.auditLog.update({
          where: { id: row.id },
          data: { prevHash, entryHash, signature },
        });
      }

      prevHash = entryHash;
      stamped += 1;
    }

    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (rows.length < PAGE) break;
  }

  // Mirror the chain head into the cursor row so future appendAudit calls
  // pick up where backfill left off.
  await prisma.$executeRawUnsafe(
    `UPDATE "AuditChainCursor" SET "lastEntryHash" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
    prevHash,
    CURSOR_ID
  );

  // eslint-disable-next-line no-console
  console.log(`audit chain: stamped ${stamped} rows; head=${prevHash ?? '(empty)'}`);
}

async function backfillVerificationChains(prisma: PrismaClient): Promise<void> {
  // Process per proofId so each chain is internally consistent. Find
  // every distinct proofId that has at least one un-stamped row.
  const proofIds = await prisma.$queryRawUnsafe<Array<{ proofId: string }>>(
    `SELECT DISTINCT "proofId" FROM "VerificationRecord" WHERE "entryHash" = ''`
  );

  let totalStamped = 0;
  for (const { proofId } of proofIds) {
    // Resume support: pick up the per-proof head from existing stamped rows.
    const head = await prisma.$queryRawUnsafe<Array<{ entryHash: string | null }>>(
      `SELECT "entryHash" FROM "VerificationRecord"
         WHERE "proofId" = $1 AND "entryHash" <> ''
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT 1`,
      proofId
    );
    let prevHash: string | null = head[0]?.entryHash ?? null;

    const rows = await prisma.verificationRecord.findMany({
      where: { proofId, entryHash: '' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    for (const row of rows) {
      const entryHash = computeVerificationEntryHash({
        prevHash,
        proofId: row.proofId,
        method: row.method,
        result: row.result,
        tier: row.tier,
        requesterContext: row.requesterContext,
        createdAt: row.createdAt,
      });
      await prisma.verificationRecord.update({
        where: { id: row.id },
        data: { prevHash, entryHash },
      });
      prevHash = entryHash;
      totalStamped += 1;
    }

    // Seed the per-proof cursor so future appends chain correctly.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "VerificationChainCursor" ("proofId", "lastEntryHash", "updatedAt")
       VALUES ($1, $2, NOW())
       ON CONFLICT ("proofId") DO UPDATE SET "lastEntryHash" = EXCLUDED."lastEntryHash", "updatedAt" = NOW()`,
      proofId,
      prevHash
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `verification chains: stamped ${totalStamped} rows across ${proofIds.length} proofs`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
