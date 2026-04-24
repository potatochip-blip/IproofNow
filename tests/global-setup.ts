// Vitest global setup — runs once before the whole suite.
//   1. Refuse to run if DATABASE_URL_TEST doesn't end in _test (safety guard).
//   2. Push the Prisma schema into the test DB (faster than migrate for tests).

import { execSync } from 'node:child_process';

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
}
