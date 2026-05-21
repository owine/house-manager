import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('weekly + seasonal recurrence picker round-trip', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Lawn');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  await page
    .getByRole('navigation', { name: 'Item tabs' })
    .getByRole('link', { name: 'reminders' })
    .click();
  await page.getByRole('button', { name: '+ Add reminder' }).click();
  await page.getByLabel('Title').fill('Mow the lawn');
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));

  // Click labels (the bare RadioGroupItem radio is "outside of viewport").
  await page.locator('label[for="recur-weekly"]').click();
  const weekdays = page.getByRole('group', { name: 'Weekdays' });
  await weekdays.getByRole('button', { name: 'Thu', exact: true }).click(); // Mon([1]) default
  await expect(weekdays.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(weekdays.getByRole('button', { name: 'Thu', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.locator('label[for="recur-seasonal"]').click();
  const months = page.getByRole('group', { name: 'Active months' });
  for (const m of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) {
    await months.getByRole('button', { name: m, exact: true }).click();
  }

  // Deselecting the last month auto-disables the seasonal switch (no on-with-zero no-op).
  for (const m of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) {
    await months.getByRole('button', { name: m, exact: true }).click();
  }
  await expect(page.locator('#recur-seasonal')).not.toBeChecked();

  // Re-enable + re-select for the actual save.
  await page.locator('label[for="recur-seasonal"]').click();
  const months2 = page.getByRole('group', { name: 'Active months' });
  for (const m of ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) {
    await months2.getByRole('button', { name: m, exact: true }).click();
  }

  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  await expect(page.getByText('Every Mon & Thu (Apr–Oct)')).toBeVisible(); // en dash U+2013
});
