import { defineConfig } from 'vitest/config';

// One config, two test surfaces. Unit and integration are split by directory
// path in the package.json scripts (test:unit / test:integration). This is
// simpler than Vitest's `projects` feature and avoids version-coupling.
export default defineConfig({
  resolve: {
    alias: { '@': new URL('./', import.meta.url).pathname },
  },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'lib/**/*.test.ts',
      'worker/**/*.test.ts',
    ],
    // Integration suites need long timeouts for Testcontainers cold start.
    // The unit-only run uses --testTimeout via the script, but defaults are
    // generous enough not to hurt.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
