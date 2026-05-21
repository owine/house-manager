// Full-suite (NOT @critical) e2e: minimal note create → appears flow.
// Mirrors reminders.spec / systems.spec harness usage.
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('creates a note and lands on its detail page', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/notes/new');
  await page.getByLabel('Title').fill('Spare key location');
  // Body is required; the NoteEditor textarea has id="body" but no <label for>,
  // so target it by id rather than getByLabel.
  await page.locator('#body').fill('Hidden under the third flowerpot.');
  await page.getByRole('button', { name: 'Save note' }).click();

  await expect(page).toHaveURL(/\/notes\/c[a-z0-9]+$/);
  await expect(page.getByRole('heading', { name: 'Spare key location' })).toBeVisible();

  // Appears in the notes list too.
  await page.goto('/notes');
  await expect(page.getByText('Spare key location')).toBeVisible();
});
