// Loaded BEFORE every test file. Two jobs:
//   1. Point Prisma at the dedicated *_test database.
//   2. Install the in-memory cookie jar that route handlers use via
//      next/headers cookies(). This lets us call route handlers directly
//      without spinning up a Next dev server.

import { vi, beforeEach } from 'vitest';
import { resetCookieJar } from './cookie-jar';

if (!process.env['DATABASE_URL_TEST']) {
  throw new Error('DATABASE_URL_TEST must be set for tests (see .env.example)');
}
process.env['DATABASE_URL'] = process.env['DATABASE_URL_TEST'];
// @types/node v20+ types NODE_ENV as a readonly literal. Object.assign sidesteps it.
Object.assign(process.env, { NODE_ENV: 'test' });

vi.mock('next/headers', async () => {
  const { mockCookies } = await import('./cookie-jar');
  return {
    cookies: () => mockCookies(),
    headers: () => new Headers(),
  };
});

beforeEach(() => {
  resetCookieJar();
});
