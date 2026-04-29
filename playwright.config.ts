import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  // Serialize specs: they share auth tables in one DB, so concurrent OAuth
  // callbacks race on the User row's unique email constraint.
  workers: 1,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // The webServer inherits env vars from the process that spawns Playwright,
    // so AUTH_OIDC_ISSUER=http://localhost:9999 must be set when invoking pnpm test:e2e.
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
