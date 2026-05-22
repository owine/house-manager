import { expect, type Page } from '@playwright/test';

export const EMPTY_ROUTES: Array<{ name: string; path: string }> = [
  { name: 'dashboard-empty', path: '/dashboard' },
  { name: 'items-empty', path: '/items' },
  { name: 'items-new', path: '/items/new' },
  { name: 'systems-empty', path: '/systems' },
  { name: 'systems-new', path: '/systems/new' },
  { name: 'vendors-empty', path: '/vendors' },
  { name: 'vendors-new', path: '/vendors/new' },
  { name: 'service-empty', path: '/service' },
  { name: 'service-new', path: '/service/new' },
  { name: 'reminders-empty', path: '/reminders' },
  { name: 'reminders-new', path: '/reminders/new' },
  { name: 'reminders-calendar', path: '/reminders/calendar' },
  { name: 'chores-empty', path: '/chores' },
  { name: 'chores-new', path: '/chores/new' },
  { name: 'checklists-empty', path: '/checklists' },
  { name: 'checklists-new', path: '/checklists/new' },
  { name: 'notes-empty', path: '/notes' },
  { name: 'notes-new', path: '/notes/new' },
  { name: 'inbox-empty', path: '/inbox' },
  { name: 'search-empty', path: '/search' },
  { name: 'ask-empty', path: '/ask' },
  { name: 'settings', path: '/settings' },
  { name: 'admin', path: '/admin' },
  { name: 'admin-ai', path: '/admin/ai' },
];

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

export type SeededUrls = {
  itemUrl: string;
  serviceUrl: string;
  reminderUrl: string;
  noteUrl: string;
};

export async function seedPopulated(
  page: Page,
  opts?: { onSuggestInterstitial?: (page: Page) => Promise<void> },
): Promise<SeededUrls> {
  // Submit helper: arm the navigation wait BEFORE the click (race-safe — a fast
  // server-action response can complete before a post-click waitForURL starts
  // listening, hanging forever; this is the pattern the CI-gated specs use).
  const submitAndWait = async (url: RegExp, click: () => Promise<void>) => {
    await Promise.all([page.waitForURL(url, { timeout: 60_000 }), click()]);
  };
  const createBtn = () => page.getByRole('button', { name: /^(Create|Save)/ }).first();

  await page.goto('/vendors/new');
  await page.getByLabel('Name').fill('Acme HVAC Services');
  await submitAndWait(/\/vendors\/c[a-z0-9]+$/, () => createBtn().click());

  await page.goto('/systems/new');
  await page.getByLabel('Name').fill('Heating');
  await submitAndWait(/\/systems\/c[a-z0-9]+$/, () => createBtn().click());

  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await submitAndWait(/\/items\/c[a-z0-9]+\/suggest-after-create$/, () =>
    page.getByRole('button', { name: 'Create item' }).click(),
  );
  if (opts?.onSuggestInterstitial) await opts.onSuggestInterstitial(page);
  await submitAndWait(/\/items\/c[a-z0-9]+$/, () =>
    page.getByRole('button', { name: 'Skip' }).click(),
  );
  const itemUrl = page.url();
  const itemId = itemUrl.match(/\/items\/(c[a-z0-9]+)/)?.[1];

  await page.goto(`/service/new?itemId=${itemId}`);
  const performedOn = page.getByLabel('Performed on');
  await performedOn.fill('2026-04-15');
  await expect(performedOn).toHaveValue('2026-04-15'); // wait for native-date React state to commit
  await page.getByLabel('Summary').fill('Annual tune-up');
  await submitAndWait(/\/service\/c[a-z0-9]+$/, () =>
    page.getByRole('button', { name: 'Save record' }).click(),
  );
  const serviceUrl = page.url();

  await page.goto('/reminders/new');
  await page.getByLabel('Title').fill('Change furnace filter');
  const dueDate = page.getByLabel('First due date');
  await dueDate.fill('2026-06-01');
  await expect(dueDate).toHaveValue('2026-06-01');
  await submitAndWait(/\/reminders\/c[a-z0-9]+$/, () => createBtn().click());
  const reminderUrl = page.url();

  await page.goto('/notes/new');
  await page
    .getByLabel(/Title|Subject/)
    .first()
    .fill('Furnace install notes');
  const noteBody = page.getByLabel(/Body|Content/).first();
  if (await noteBody.isVisible().catch(() => false)) {
    await noteBody.fill('Filter size: 20x25x1. Replace quarterly.');
  }
  await submitAndWait(/\/notes\/c[a-z0-9]+$/, () => createBtn().click());
  const noteUrl = page.url();

  return { itemUrl, serviceUrl, reminderUrl, noteUrl };
}

export function populatedRoutes(urls: SeededUrls): Array<{ name: string; path: string }> {
  return [
    { name: 'dashboard-populated', path: '/dashboard' },
    { name: 'items-populated', path: '/items' },
    { name: 'item-detail', path: urls.itemUrl },
    { name: 'systems-populated', path: '/systems' },
    { name: 'vendors-populated', path: '/vendors' },
    { name: 'service-populated', path: '/service' },
    { name: 'service-detail', path: urls.serviceUrl },
    { name: 'reminders-populated', path: '/reminders' },
    { name: 'reminder-detail', path: urls.reminderUrl },
    { name: 'reminders-calendar-populated', path: '/reminders/calendar' },
    { name: 'notes-populated', path: '/notes' },
    { name: 'note-detail', path: urls.noteUrl },
    { name: 'search-furnace', path: '/search?q=furnace' },
  ];
}
