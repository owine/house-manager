import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('signs in, adds an item, logs service, sees activity on dashboard', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // Create a new item
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

  // After submit we land on the item detail page (cuid id, not "new")
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  await expect(page.locator('h1')).toContainText('Furnace');

  // Switch to the Service tab
  await page.getByRole('link', { name: 'Service' }).click();
  // Click the "+ Log service" button. Base UI's Button keeps role="button" even
  // when render={<Link>} produces an <a>; query by role=button, not role=link.
  await page.getByRole('button', { name: '+ Log service' }).click();

  // Fill the service record form — item is pre-filled via ?itemId= query param
  await page.getByLabel('Performed on').fill('2026-04-15');
  await page.getByLabel('Summary').fill('Annual tune-up');
  // submitLabel on /service/new is "Save record"
  await page.getByRole('button', { name: 'Save record' }).click();

  // After submit we land on the service record detail page (cuid id, not "new")
  await expect(page).toHaveURL(/\/service\/c[a-z0-9]+$/);

  // Navigate to dashboard and confirm the activity entry is visible.
  // The label format is "Logged service for Furnace: Annual tune-up"
  // so asserting on the summary text is sufficient.
  await page.goto('/dashboard');
  await expect(page.locator('text=Annual tune-up')).toBeVisible();
});
