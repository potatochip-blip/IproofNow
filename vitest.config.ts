import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/test-env.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
});
