// Full-suite (NOT @critical) e2e: checklists list split-button menu renders the
// AI generate options, and the primary "New checklist" path still creates a checklist.
// AI generation itself is not exercised (placeholder Anthropic key in e2e).
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('checklists split button: AI menu renders + manual create works', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/checklists');

  // The caret opens a menu with the two AI options in alphabetical order.
  await page.getByRole('button', { name: /More create options/i }).click();
  await expect(page.getByRole('menuitem', { name: /Generate from prompt/i })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Generate seasonal/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: /Generate seasonal/i })).not.toBeVisible();

  // The primary segment still navigates to the manual create form.
  await page.locator('a[href="/checklists/new"]').first().click();
  await expect(page).toHaveURL(/\/checklists\/new$/);

  await page.getByLabel('Name').fill('Garage spring clean');
  await page.getByRole('button', { name: 'Create checklist' }).click();
  await expect(page).toHaveURL(/\/checklists\/c[a-z0-9]+$/);
  await expect(page.getByRole('heading', { name: 'Garage spring clean' })).toBeVisible();
});
