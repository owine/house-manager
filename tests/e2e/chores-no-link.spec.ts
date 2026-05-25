import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('linkless chore: create + complete @critical', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // Create a chore with NO item/system links. The form's targets picker is
  // intentionally left untouched — Task 4 dropped the chore targets gate.
  await page.goto('/chores/new');
  await page.getByLabel('Title').fill('Sharpen the kitchen knife');
  // Default recurrence is `{ kind: 'interval', every: 60, unit: 'day' }`, so
  // we don't need to interact with the recurrence picker.
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));

  await Promise.all([
    page.waitForURL(/\/reminders\/c[a-z0-9]+$/, { timeout: 60_000 }),
    page.getByRole('button', { name: 'Create chore' }).click(),
  ]);

  await expect(page.getByRole('heading', { name: 'Sharpen the kitchen knife' })).toBeVisible();

  // Regression guard for Task 5's "for —" hanger: when a chore has zero
  // targets the detail page used to render `for ` (with no chips after).
  // The fix wraps the literal "for " inside the same conditional as the
  // chips block, so the affix should not appear anywhere in the heading +
  // meta row. We assert against the meta row specifically (the small row
  // right below PageHeader that renders status + recurrence + optional
  // `for <targets>`), so unrelated body copy can't flake this.
  const metaRow = page
    .getByText(/Every 60 days/)
    .locator('xpath=ancestor::div[contains(@class, "flex-wrap")][1]');
  await expect(metaRow).toBeVisible();
  await expect(metaRow).not.toContainText(/\bfor\b/);

  // Mark complete — CompleteReminderForm starts collapsed; first click opens
  // the inline form, then "Save completion" submits.
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await page.getByRole('button', { name: 'Save completion' }).click();

  // After completion the History card increments and shows the entry.
  await expect(page.getByText(/History \(1\)/)).toBeVisible();
});
