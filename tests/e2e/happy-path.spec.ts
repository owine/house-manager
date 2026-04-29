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
  // Category is a <select> — selectOption by value (slug)
  await page.getByLabel('Category').selectOption('hvac');
  await page.getByRole('button', { name: 'Create item' }).click();

  // After submit we land on the item detail page
  await expect(page).toHaveURL(/\/items\/[^/]+$/);
  await expect(page.locator('h1')).toContainText('Furnace');

  // Switch to the Service tab
  await page.getByRole('link', { name: 'Service' }).click();
  // Click the "+ Log service" link
  await page.getByRole('link', { name: '+ Log service' }).click();

  // Fill the service record form — item is pre-filled via ?itemId= query param
  await page.getByLabel('Performed on').fill('2026-04-15');
  await page.getByLabel('Summary').fill('Annual tune-up');
  // submitLabel on /service/new is "Save record"
  await page.getByRole('button', { name: 'Save record' }).click();

  // After submit we land on the service record detail page
  await expect(page).toHaveURL(/\/service\/[^/]+$/);

  // Navigate to dashboard and confirm the activity entry is visible.
  // The label format is "Logged service for Furnace: Annual tune-up"
  // so asserting on the summary text is sufficient.
  await page.goto('/dashboard');
  await expect(page.locator('text=Annual tune-up')).toBeVisible();
});
