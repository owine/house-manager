// Full-suite (NOT @critical) e2e: minimal vendor create → appears flow.
// Mirrors reminders.spec / systems.spec harness usage.
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('creates a vendor and lands on its detail page', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/vendors/new');
  await page.getByLabel('Name').fill('Acme Plumbing');
  await page.getByLabel('Kind').fill('plumber');
  await page.getByRole('button', { name: 'Create vendor' }).click();

  await expect(page).toHaveURL(/\/vendors\/c[a-z0-9]+$/);
  await expect(page.getByRole('heading', { name: 'Acme Plumbing' })).toBeVisible();

  // Appears in the vendor list too.
  await page.goto('/vendors');
  await expect(page.getByRole('link', { name: 'Acme Plumbing' })).toBeVisible();
});
