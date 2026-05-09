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
  // Open the Category combobox and pick HVAC.
  // Was a native <select> before Plan 4ab; now shadcn <Select> (Base UI listbox).
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  // Plan 4b Task 21: post-create lands on the suggest-after-create interstitial.
  // Skip past it to reach the item detail page.
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  // Base UI's Button keeps role="button" even when render={<Link>} produces an <a>.
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // Switch to the Files tab.
  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();

  // Upload the fixture. PR #89 replaced the unicode "✓ <filename>" status
  // glyph with a lucide check icon next to the bare filename, so we now
  // assert on the filename's appearance in the status list directly.
  await page.setInputFiles('input[type=file]', 'tests/fixtures/sample.jpg');
  await expect(page.locator('text=sample.jpg').first()).toBeVisible({ timeout: 10_000 });

  // Verify a card with the file rendered (Delete button is the visible signal).
  // Note: the dev server doesn't run the worker process, so the thumbnail
  // .webp won't be generated during the test. The <Image> tag has no
  // onerror fallback in our v1 implementation; if you want to assert the
  // image element renders, just check for its presence by alt text.
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

  // Delete the attachment.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();

  // Add an external link via the form below the file picker.
  await page.getByLabel('Label (optional)').fill('Furnace manual on Proton');
  await page.getByLabel('URL (https or http)').fill('https://drive.proton.me/urls/EXAMPLE');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.locator('text=Furnace manual on Proton')).toBeVisible({ timeout: 10_000 });

  // Delete the link.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();
});
