import type { Page } from '@playwright/test';

export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in with Authelia' }).click(),
  ]);
}
