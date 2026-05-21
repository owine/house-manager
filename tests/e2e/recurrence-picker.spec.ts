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

// Create an HVAC item and open its "add reminder" form with title + first-due-date
// pre-filled. Returns with the recurrence picker on screen, ready to configure.
async function openReminderForm(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
  itemName: string,
  title: string,
) {
  await context.clearCookies();
  await signIn(page);
  await page.goto('/items/new');
  await page.getByLabel('Name').fill(itemName);
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
  await page.getByLabel('Title').fill(title);
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
}

// Parent row <div> of a recurrence radio (the radio + its controls share one row),
// used to scope ambiguous "Add" buttons / inputs to a single kind.
function row(page: import('@playwright/test').Page, forId: string) {
  return page.locator(`label[for="${forId}"]`).locator('xpath=..');
}

test('monthly multi-day (semi-monthly) round-trip', async ({ page, context }) => {
  await openReminderForm(page, context, 'Filter A', 'Replace filter');
  await page.locator('label[for="recur-monthly"]').click();

  const monthly = row(page, 'recur-monthly'); // default day chip: 1
  await monthly.getByLabel('Day of month to add').fill('15');
  await monthly.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(monthly.getByRole('group', { name: 'Selected days of month' })).toContainText('15');

  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  await expect(page.getByText('Monthly on the 1st & 15th')).toBeVisible();
});

test('nth-weekday combos round-trip + label-bug fix (shows words not numbers)', async ({
  page,
  context,
}) => {
  await openReminderForm(page, context, 'Furnace B', 'Inspect furnace');
  await page.locator('label[for="recur-monthly-weekday"]').click();

  const mw = row(page, 'recur-monthly-weekday');
  // Label-bug regression guard: selects must render labels, not raw values ("1").
  await expect(mw.getByRole('combobox', { name: 'Week position' })).toContainText('First');
  await expect(mw.getByRole('combobox', { name: 'Weekday' })).toContainText('Monday');

  // Default combo is First Monday; add Third Monday.
  await mw.getByRole('combobox', { name: 'Week position' }).click();
  await page.getByRole('option', { name: 'Third' }).click();
  await mw.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(mw.getByRole('group', { name: 'Selected nth-weekday combos' })).toContainText(
    'Third Monday',
  );

  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  await expect(page.getByText('First & Third Monday of the month')).toBeVisible();
});

test('bi-weekly (every other Tuesday) round-trip', async ({ page, context }) => {
  await openReminderForm(page, context, 'Pump C', 'Run pump');
  await page.locator('label[for="recur-weekly"]').click();

  await page.getByLabel('Weeks between occurrences').fill('2');
  const weekdays = page.getByRole('group', { name: 'Weekdays' });
  await weekdays.getByRole('button', { name: 'Tue', exact: true }).click(); // now Mon + Tue
  await weekdays.getByRole('button', { name: 'Mon', exact: true }).click(); // now Tue only

  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  await expect(page.getByText('Every other Tuesday')).toBeVisible();
});

test('yearly multi-date calendar round-trip', async ({ page, context }) => {
  await openReminderForm(page, context, 'Roof D', 'Roof check');
  await page.locator('label[for="recur-yearly"]').click();

  // Default date chip is Jan 1; add Jul 1 via the calendar popover.
  await page.getByRole('button', { name: 'Add date' }).click();
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Next month' }).click(); // Jan → Jul
  }
  await expect(page.getByText('July')).toBeVisible();
  await page.getByRole('button', { name: '1', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Selected dates' })).toContainText('Jul 1');

  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  await expect(page.getByText('Every year on Jan 1 & Jul 1')).toBeVisible();
});
