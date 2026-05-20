// Full-suite (NOT @critical) e2e: minimal service-record create → appears flow.
// Service records are created via /service/new?itemId=<id>, which pre-seeds the
// item as the sole target, so we only fill the required form fields.
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('logs a service record for an item and sees it on the item', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // Item-create preamble (mirrors reminders.spec): create an HVAC item.
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace Unit');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  const itemId = page.url().match(/\/items\/(c[a-z0-9]+)$/)?.[1];
  if (!itemId) throw new Error(`expected /items/<id>, got ${page.url()}`);

  // Launch the service-record form with the item pre-seeded as a target.
  await page.goto(`/service/new?itemId=${itemId}`);
  await page.getByLabel('Summary').fill('Annual tune-up');
  // Native date input: fill then assert the value committed before submitting.
  const performedOn = page.getByLabel('Performed on');
  await performedOn.fill('2026-04-01');
  await expect(performedOn).toHaveValue('2026-04-01');

  await Promise.all([
    page.waitForURL(/\/service\/c[a-z0-9]+$/, { timeout: 60_000 }),
    page.getByRole('button', { name: 'Save record' }).click(),
  ]);
  await expect(page.getByRole('heading', { name: 'Annual tune-up' })).toBeVisible();

  // The same record shows on the item's Service tab.
  await page.goto(`/items/${itemId}?tab=service`);
  await expect(page.getByText('Annual tune-up')).toBeVisible();
});
