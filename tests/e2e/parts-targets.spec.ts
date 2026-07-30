// The end-to-end guard for the part-target form chain.
//
// The PR 1a integration tests call createReminder/updateReminder directly, so
// they cannot see the failure this spec exists for: a picker that renders a
// part row it doesn't understand as "nothing" makes the edit form submit a
// targets array WITHOUT that row, and updateReminder's diff — seeing it in
// `have` but not `want` — deletes it. Nothing errors; the target is just gone.
//
// Asserting only that "a target with this partId exists" would also pass
// against delete-and-recreate, which silently loses lastCompletedOn/nextDueOn.
// The assertion that matters is the target ROW ID surviving the round-trip.

import { expect, test } from '@playwright/test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { resetAuth, signIn } from './auth';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

test.beforeEach(async () => {
  await resetAuth();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a part-targeted reminder survives an untouched re-save through the form @critical', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // 1. Create a part.
  await page.goto('/parts/new');
  await page.getByLabel('Name').fill('20x25x1 furnace filter');
  await page.getByTestId('part-form-kind-trigger').click();
  await page.getByRole('option', { name: 'Air filter' }).click();
  await page.getByRole('button', { name: 'Create part' }).click();
  await expect(page).toHaveURL(/\/parts\/c[a-z0-9]+$/);
  const partId = page.url().split('/').pop() as string;

  // 2. Target it from a new reminder, picking it through the picker itself
  //    (not a ?partId= prefill) so the Parts affordance is exercised.
  await page.goto('/reminders/new');
  await page.getByLabel('Title').fill('Swap furnace filter');
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: /^Parts/ }).click();
  // Click the label, not the checkbox: the Base UI control is visually
  // collapsed and Playwright reports it as outside the viewport.
  await page.locator(`label[for="targets-part-${partId}"]`).click();
  await expect(page.getByTestId('targets-picker-chips')).toContainText('20x25x1 furnace filter');
  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  const reminderId = page.url().split('/').pop() as string;

  // The detail page renders the part chip.
  await expect(page.getByTestId('targets-chips')).toContainText('20x25x1 furnace filter');

  const before = await prisma.reminderTarget.findMany({ where: { reminderId } });
  expect(before).toHaveLength(1);
  expect(before[0].partId).toBe(partId);

  // 3. Re-save through the FORM PATH, touching nothing.
  await page.goto(`/reminders/${reminderId}/edit`);
  // The seeded part target is visible and editable here — before PR 1b it was
  // in neither the chips nor the list.
  await expect(page.getByTestId('targets-picker-chips')).toContainText('20x25x1 furnace filter');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/reminders/${reminderId}$`));

  // 4. Same row, same id — not a delete-and-recreate.
  const after = await prisma.reminderTarget.findMany({ where: { reminderId } });
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before[0].id);
  expect(after[0].partId).toBe(partId);
  expect(after[0].nextDueOn).toEqual(before[0].nextDueOn);
});

// A CHORE may legally save with zero targets, so no client-side guard stands
// between a dropped part row and the reconciliation diff. This is the case
// where the loss is completely silent, which makes the row-id assertion below
// the one doing the work.
test('a part-targeted chore keeps its target row on an untouched re-save', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/parts/new');
  await page.getByLabel('Name').fill('Water softener salt');
  await page.getByRole('button', { name: 'Create part' }).click();
  await expect(page).toHaveURL(/\/parts\/c[a-z0-9]+$/);
  const partId = page.url().split('/').pop() as string;

  await page.goto(`/chores/new?partId=${partId}`);
  await expect(page.getByTestId('targets-picker-chips')).toContainText('Water softener salt');
  await page.getByLabel('Title').fill('Restock softener salt');
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Create chore' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  const reminderId = page.url().split('/').pop() as string;

  const before = await prisma.reminderTarget.findMany({ where: { reminderId } });
  expect(before).toHaveLength(1);
  expect(before[0].partId).toBe(partId);

  await page.goto(`/reminders/${reminderId}/edit`);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/reminders/${reminderId}$`));

  const after = await prisma.reminderTarget.findMany({ where: { reminderId } });
  expect(after).toHaveLength(1);
  // Not a standalone sentinel, and not a delete-and-recreate.
  expect(after[0].partId).toBe(partId);
  expect(after[0].id).toBe(before[0].id);
});

test('a part target can be removed and re-added from the reminder edit form', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/parts/new');
  await page.getByLabel('Name').fill('Fridge water filter');
  await page.getByRole('button', { name: 'Create part' }).click();
  await expect(page).toHaveURL(/\/parts\/c[a-z0-9]+$/);
  const partId = page.url().split('/').pop() as string;

  // Prefill branch: /reminders/new?partId= seeds the picker.
  await page.goto(`/reminders/new?partId=${partId}`);
  await expect(page.getByTestId('targets-picker-chips')).toContainText('Fridge water filter');
  await page.getByLabel('Title').fill('Replace fridge filter');
  await page
    .getByLabel('First due date')
    .fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  const reminderId = page.url().split('/').pop() as string;

  // Remove it via the chip's X, then save: the target is gone…
  await page.goto(`/reminders/${reminderId}/edit`);
  await page.getByRole('button', { name: 'Remove part Fridge water filter' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Select at least one item, system, or part')).toBeVisible();

  // …the client-side guard blocks the empty save, so re-check it and save.
  await page.getByRole('button', { name: /^Parts/ }).click();
  await page.locator(`label[for="targets-part-${partId}"]`).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/reminders/${reminderId}$`));

  const targets = await prisma.reminderTarget.findMany({ where: { reminderId } });
  expect(targets).toHaveLength(1);
  expect(targets[0].partId).toBe(partId);
});
