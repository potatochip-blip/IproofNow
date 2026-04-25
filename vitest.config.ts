import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Load .env so DATABASE_URL_TEST is visible to globalSetup + workers.
// Node 20.6+ ships loadEnvFile; the optional chain keeps older nodes booting.
process.loadEnvFile?.();

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
