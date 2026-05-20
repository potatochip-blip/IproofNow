/**
 * Phase 8 one-shot — re-stamp the per-proof verification record chains.
 *
 * Phase 8 folded `tier` into the VerificationRecord entryHash composition
 * (and converted `result` from a String to the VerificationResult enum).
 * Both change the hashed representation, so every entryHash written before
 * Phase 8 is now stale — verifyVerificationChain reports those rows broken
 * until this script runs.
 *
 * This walks every proof's verification records in (createdAt asc, id asc)
 * order and recomputes entryHash under the current composition, updating
 * the row and the per-proof VerificationChainCursor head. Run it once,
 * immediately after applying the Phase 8 migration.
 *
 * Deterministic and idempotent — re-running recomputes identical values.
 * Refuses to run in NODE_ENV=production without --allow-prod.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-verification-result.ts
 *   pnpm tsx scripts/backfill-verification-result.ts --allow-prod
 */

import { PrismaClient } from '@prisma/client';
import { computeVerificationEntryHash } from '../lib/verification-chain';

async function main() {
  const allowProd = process.argv.includes('--allow-prod');
  if (process.env.NODE_ENV === 'production' && !allowProd) {
    throw new Error('Refusing to run in production without --allow-prod.');
  }

  const prisma = new PrismaClient();
  try {
    const proofIds = await prisma.$queryRawUnsafe<Array<{ proofId: string }>>(
      `SELECT DISTINCT "proofId" FROM "VerificationRecord"`
    );

    let restamped = 0;
    for (const { proofId } of proofIds) {
      const rows = await prisma.verificationRecord.findMany({
        where: { proofId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      let prevHash: string | null = null;
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
        restamped += 1;
      }

      // Re-seed the per-proof cursor head so future appends chain correctly.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "VerificationChainCursor" ("proofId", "lastEntryHash", "updatedAt")
         VALUES ($1, $2, NOW())
         ON CONFLICT ("proofId")
         DO UPDATE SET "lastEntryHash" = EXCLUDED."lastEntryHash", "updatedAt" = NOW()`,
        proofId,
        prevHash
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `verification chains: re-stamped ${restamped} record(s) across ${proofIds.length} proof(s)`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
