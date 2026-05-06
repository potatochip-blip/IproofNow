// Vitest global setup — runs once before the whole suite.
//   1. Refuse to run if DATABASE_URL_TEST doesn't end in _test (safety guard).
//   2. Push the Prisma schema into the test DB (faster than migrate for tests).
//   3. Apply Phase 6 trigger SQL (db push doesn't run migration SQL).

import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// Prisma's $executeRawUnsafe uses the prepared-statement protocol (single
// statement only). Split the trigger DDL into discrete statements.
const PHASE6_TRIGGER_STATEMENTS: string[] = [
  `CREATE OR REPLACE FUNCTION audit_log_immutable_reveal()
   RETURNS TRIGGER AS $$
   BEGIN
     IF OLD."action" = 'proof.hidden.revealed'
        AND (NOW() - OLD."createdAt") < INTERVAL '24 hours' THEN
       RAISE EXCEPTION
         'AuditLog row % is immutable: action=%, age < 24 hours',
         OLD."id", OLD."action"
         USING ERRCODE = 'check_violation';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS audit_log_immutable_reveal_trigger ON "AuditLog"`,
  `CREATE TRIGGER audit_log_immutable_reveal_trigger
     BEFORE UPDATE ON "AuditLog"
     FOR EACH ROW
     EXECUTE FUNCTION audit_log_immutable_reveal()`,
];

export default async function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error('DATABASE_URL_TEST must be set for tests (see .env.example)');
  }
  if (!/_test(\?|$)/.test(url)) {
    throw new Error(
      `Refusing to run tests against DATABASE_URL_TEST that does not end in "_test": ${url}`
    );
  }

  execSync('pnpm prisma db push --skip-generate --accept-data-loss --force-reset', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  // Phase 6: db push doesn't execute migration SQL, so apply the
  // immutable-reveal trigger explicitly. Idempotent via DROP TRIGGER IF EXISTS.
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    for (const stmt of PHASE6_TRIGGER_STATEMENTS) {
      await client.$executeRawUnsafe(stmt);
    }
    // Seed the global audit chain cursor.
    await client.$executeRawUnsafe(
      `INSERT INTO "AuditChainCursor" ("id", "updatedAt") VALUES ('global', NOW()) ON CONFLICT DO NOTHING`
    );
  } finally {
    await client.$disconnect();
  }
}
