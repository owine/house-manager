// Full-suite (NOT @critical) e2e: minimal warranty create → appears flow.
// Warranties have no standalone /new route; they are created nested under an
// item (Item detail → Warranties tab → "+ Add warranty"). The new-warranty
// page pre-seeds the item as the sole target, so we only fill the form fields.
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('creates a warranty nested under an item and sees it on the item', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // Item-create preamble (mirrors reminders.spec): create an HVAC item.
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Water Heater');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // Open the Warranties tab and start a new warranty.
  await page
    .getByRole('navigation', { name: 'Item tabs' })
    .getByRole('link', { name: 'warranties' })
    .click();
  await page.getByRole('button', { name: '+ Add warranty' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/warranties\/new$/);

  // The target is pre-seeded; fill the required warranty fields.
  await page.getByLabel('Provider').fill('AcmeCare');
  await page.getByLabel('Starts on').fill('2026-01-01');
  await page.getByLabel('Ends on').fill('2027-01-01');
  await page.getByRole('button', { name: 'Add warranty' }).click();

  // Redirects back to the item's warranties tab where the new warranty appears.
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\?tab=warranties$/);
  await expect(page.getByText('AcmeCare')).toBeVisible();
});
