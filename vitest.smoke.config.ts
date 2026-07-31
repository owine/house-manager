import { defineConfig } from 'vitest/config';
import { dotenvFallbacks } from './vitest.env';

// The smoke suite calls the real Anthropic API. It's intentionally separate
// from the unit/integration configs so a CI run of `pnpm test:unit` or
// `pnpm test:integration` never burns API credits or fails on a missing key.
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
  test: {
    // The whole point of this suite is a live call, so it needs the real key
    // — which lives in .env, which Vitest does not read on its own.
    env: dotenvFallbacks(mode),
    include: ['tests/smoke/**/*.test.ts'],
    setupFiles: [], // explicit: no global mocks
    testTimeout: 60_000,
    environment: 'node',
  },
}));
