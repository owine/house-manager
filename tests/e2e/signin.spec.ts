import { expect, test } from '@playwright/test';
import { signIn } from './auth';

test('signs in via mock OIDC and lands on dashboard', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('h1')).toContainText('Hello, Test User');
});
