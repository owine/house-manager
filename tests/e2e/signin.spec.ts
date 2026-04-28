import { expect, test } from '@playwright/test';

test('signs in via mock OIDC and lands on dashboard', async ({ page, context }) => {
  // Mock OIDC is running on port 9999 (started in globalSetup).
  // The webServer (pnpm dev) was launched with AUTH_OIDC_ISSUER=http://localhost:9999.
  // Clear any existing cookies to ensure a clean state
  await context.clearCookies();

  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  // Auth.js shows a signin page with a form that submits to /api/auth/signin/authelia
  // The form will redirect to the OIDC provider
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in with Authelia' }).click(),
  ]);
  // After the full OIDC flow, we should land on the dashboard
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('h1')).toContainText('Hello, Test User');
});
