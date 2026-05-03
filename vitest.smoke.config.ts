import { defineConfig } from 'vitest/config';

// The smoke suite calls the real Anthropic API. It's intentionally separate
// from the unit/integration configs so a CI run of `pnpm test:unit` or
// `pnpm test:integration` never burns API credits or fails on a missing key.
export default defineConfig({
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
  test: {
    include: ['tests/smoke/**/*.test.ts'],
    setupFiles: [], // explicit: no global mocks
    testTimeout: 60_000,
    environment: 'node',
  },
});
