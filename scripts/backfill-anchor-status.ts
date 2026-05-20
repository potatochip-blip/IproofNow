/**
 * Phase 7 one-shot — gate for the ProofAnchor.status enum migration.
 *
 * The Phase 7 migration converts ProofAnchor.status from a free TEXT column
 * to the AnchorStatus enum via `USING status::"AnchorStatus"`. That cast
 * fails hard if any existing row holds a value outside
 * {STUB, PENDING, CONFIRMED, FAILED}. Phase 5 only ever writes 'STUB', so
 * in practice this is a no-op — but running it first turns a possible
 * mid-migration abort into a clean, explicit pre-flight check.
 *
 * This script intentionally uses raw SQL: it is meant to run BEFORE the
 * migration, while ProofAnchor.status is still TEXT, so it must not depend
 * on the regenerated (enum-typed) Prisma client.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-anchor-status.ts             # dev / staging
 *   pnpm tsx scripts/backfill-anchor-status.ts --allow-prod
 */

import { PrismaClient } from '@prisma/client';

const VALID = new Set(['STUB', 'PENDING', 'CONFIRMED', 'FAILED']);

async function main() {
  const allowProd = process.argv.includes('--allow-prod');
  if (process.env.NODE_ENV === 'production' && !allowProd) {
    throw new Error('Refusing to run in production without --allow-prod.');
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string; n: bigint }>>(
      `SELECT "status", COUNT(*)::bigint AS n FROM "ProofAnchor" GROUP BY "status"`
    );

    if (rows.length === 0) {
      // eslint-disable-next-line no-console
      console.log('anchor status backfill: ProofAnchor is empty — nothing to gate.');
      return;
    }

    const offenders = rows.filter((r) => !VALID.has(r.status));
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.status.padEnd(10)} ${r.n} row(s)`);
    }

    if (offenders.length > 0) {
      throw new Error(
        `Found ProofAnchor.status values outside the AnchorStatus enum: ` +
          offenders.map((o) => `'${o.status}'`).join(', ') +
          `. Resolve these before applying the Phase 7 migration.`
      );
    }

    // eslint-disable-next-line no-console
    console.log('anchor status backfill: all rows map cleanly to AnchorStatus — safe to migrate.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
