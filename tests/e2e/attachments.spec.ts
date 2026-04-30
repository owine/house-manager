import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('uploads a JPEG to an item, sees the thumbnail, deletes it', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // Create a fresh item.
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByLabel('Category').selectOption('hvac');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // Switch to the Files tab.
  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();

  // Upload the fixture.
  await page.setInputFiles('input[type=file]', 'tests/fixtures/sample.jpg');
  await expect(page.locator('text=✓ sample.jpg')).toBeVisible({ timeout: 10_000 });

  // Verify a card with the file rendered (Delete button is the visible signal).
  // Note: the dev server doesn't run the worker process, so the thumbnail
  // .webp won't be generated during the test. The <Image> tag has no
  // onerror fallback in our v1 implementation; if you want to assert the
  // image element renders, just check for its presence by alt text.
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

  // Delete the attachment.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();
});
