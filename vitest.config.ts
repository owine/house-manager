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
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      // e2e helpers (e.g. mock-oidc) get pure-unit coverage here. Playwright
      // specs use `.spec.ts`, so this `.test.ts` glob never collides with them.
      'tests/e2e/**/*.test.ts',
      'lib/**/*.test.ts',
      'lib/**/*.test.tsx',
      'worker/**/*.test.ts',
      'components/**/*.test.tsx',
    ],
    // Integration suites need long timeouts for Testcontainers cold start.
    // The unit-only run uses --testTimeout via the script, but defaults are
    // generous enough not to hurt.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**', 'worker/**', 'components/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/*.config.*', '**/*.md'],
      thresholds: {
        statements: 46,
        branches: 39,
        functions: 39,
        lines: 47,
      },
    },
  },
});
