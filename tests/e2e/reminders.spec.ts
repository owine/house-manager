import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('creates a reminder, marks it complete, sees it in history @critical', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // Create an item to attach the reminder to
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

  // Switch to Reminders tab (scoped to avoid matching the sidebar nav link)
  await page
    .getByRole('navigation', { name: 'Item tabs' })
    .getByRole('link', { name: 'reminders' })
    .click();
  await expect(page.locator('text=no reminders yet')).toBeVisible();

  // Add a reminder. Base UI's Button keeps role="button" even when render={<Link>}
  // produces an <a>; query by role=button, not role=link.
  await page.getByRole('button', { name: '+ Add reminder' }).click();
  await page.getByLabel('Title').fill('Replace HVAC filter');
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);

  // Mark it complete
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await page.getByRole('button', { name: 'Save completion' }).click();

  // History shows the completion
  await expect(page.locator('text=completed by Test User')).toBeVisible({ timeout: 10_000 });

  // Settings shows iCal generation
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Generate calendar URL' }).click();
  // After generation, the URL appears in a readonly input containing the pattern /api/calendar/
  await expect(page.locator('input[readonly][value*="/api/calendar/"]')).toBeVisible({
    timeout: 5_000,
  });
});
