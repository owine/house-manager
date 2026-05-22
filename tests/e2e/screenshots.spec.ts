import { mkdir } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

const OUT_DIR = 'test-results/ui-screenshots';

const EMPTY_ROUTES: Array<{ name: string; path: string }> = [
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

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function shoot(page: Page, name: string, viewport: string) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.screenshot({
    path: `${OUT_DIR}/${viewport}/${name}.png`,
    fullPage: true,
  });
}

// Design-iteration helper, not a functional test. Skipped in CI (long runtime
// and not a regression signal); run manually with:
//   CAPTURE_SCREENSHOTS=true pnpm test:e2e:local tests/e2e/screenshots.spec.ts
const CAPTURE = process.env.CAPTURE_SCREENSHOTS === 'true';

test.beforeAll(async () => {
  if (!CAPTURE) return;
  await mkdir(`${OUT_DIR}/desktop`, { recursive: true });
  await mkdir(`${OUT_DIR}/mobile`, { recursive: true });
  await resetAuth();
});

test.skip(!CAPTURE, 'set CAPTURE_SCREENSHOTS=true to run');

test('captures UI screenshots across all routes and viewports', async ({ page, context }) => {
  test.setTimeout(600_000);
  await context.clearCookies();

  // Sign-in page (unauthenticated)
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    await page.waitForURL(/\/api\/auth\/signin/);
    await shoot(page, 'signin', vp.name);
  }

  // Auth once at default viewport
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  // Walk routes at both viewports
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const route of EMPTY_ROUTES) {
      await page.goto(route.path);
      await shoot(page, route.name, vp.name);
    }
  }

  // Populate a small amount of data so list + detail pages show real layouts.
  await page.setViewportSize({ width: 1440, height: 900 });

  // Vendor
  await page.goto('/vendors/new');
  await page.getByLabel('Name').fill('Acme HVAC Services');
  await page
    .getByRole('button', { name: /^(Create|Save)/ })
    .first()
    .click();
  await page.waitForURL(/\/vendors\/c[a-z0-9]+$/);

  // System
  await page.goto('/systems/new');
  await page.getByLabel('Name').fill('Heating');
  await page
    .getByRole('button', { name: /^(Create|Save)/ })
    .first()
    .click();
  await page.waitForURL(/\/systems\/c[a-z0-9]+$/);

  // Item
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  // Screenshot the suggest-after-create interstitial
  await shoot(page, 'suggest-after-create', 'desktop');
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.waitForURL(/\/items\/c[a-z0-9]+$/);
  const itemUrl = page.url();

  // Service record for that item. The /service/new form requires item context
  // — passing ?itemId= pre-fills the picker the same way happy-path does it via
  // the item-detail "+ Log service" button.
  const itemId = itemUrl.match(/\/items\/(c[a-z0-9]+)/)?.[1];
  await page.goto(`/service/new?itemId=${itemId}`);
  await page.getByLabel('Performed on').fill('2026-04-15');
  await page.getByLabel('Summary').fill('Annual tune-up');
  await page.getByRole('button', { name: 'Save record' }).click();
  await page.waitForURL(/\/service\/c[a-z0-9]+$/);
  const serviceUrl = page.url();

  // Reminder
  await page.goto('/reminders/new');
  await page.getByLabel('Title').fill('Change furnace filter');
  await page.getByLabel(/Due/).first().fill('2026-06-01');
  await page
    .getByRole('button', { name: /^(Create|Save)/ })
    .first()
    .click();
  await page.waitForURL(/\/reminders\/c[a-z0-9]+$/);
  const reminderUrl = page.url();

  // Note
  await page.goto('/notes/new');
  await page
    .getByLabel(/Title|Subject/)
    .first()
    .fill('Furnace install notes');
  const body = page.getByLabel(/Body|Content/).first();
  if (await body.isVisible().catch(() => false)) {
    await body.fill('Filter size: 20x25x1. Replace quarterly.');
  }
  await page
    .getByRole('button', { name: /^(Create|Save)/ })
    .first()
    .click();
  await page.waitForURL(/\/notes\/c[a-z0-9]+$/);
  const noteUrl = page.url();

  // Populated screenshots — list views + detail views, both viewports
  const populatedRoutes: Array<{ name: string; path: string }> = [
    { name: 'dashboard-populated', path: '/dashboard' },
    { name: 'items-populated', path: '/items' },
    { name: 'item-detail', path: itemUrl },
    { name: 'systems-populated', path: '/systems' },
    { name: 'vendors-populated', path: '/vendors' },
    { name: 'service-populated', path: '/service' },
    { name: 'service-detail', path: serviceUrl },
    { name: 'reminders-populated', path: '/reminders' },
    { name: 'reminder-detail', path: reminderUrl },
    { name: 'reminders-calendar-populated', path: '/reminders/calendar' },
    { name: 'notes-populated', path: '/notes' },
    { name: 'note-detail', path: noteUrl },
    { name: 'search-furnace', path: '/search?q=furnace' },
  ];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const route of populatedRoutes) {
      await page.goto(route.path);
      await shoot(page, route.name, vp.name);
    }
  }
});
