import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('signs in via mock OIDC and lands on dashboard', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('h1')).toContainText('hello, Test User');
});
