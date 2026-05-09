// Playwright E2E coverage for the systems feature: multi-target service records
// (with auto-expand), per-target reminder completion, and vendor link round-trip.
//
// Task 18 of the systems plan called the file tests/smoke/systems.spec.ts, but
// `tests/smoke/` is for live-API vitest specs (`pnpm test:smoke`). The Playwright
// harness scans `tests/e2e/`, so the file lives here instead. Run with
// `pnpm test:e2e tests/e2e/systems.spec.ts`.

import { expect, test } from '@playwright/test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { resetAuth, signIn } from './auth';

// Direct DB access for backend-state assertions (Test 2). Mirrors auth.ts so the
// spec stays self-contained.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

test.beforeEach(async () => {
  await resetAuth();
  // resetAuth() doesn't truncate `systems` (no FK from items/vendors back into
  // it; Item.systemId is SET NULL on delete), so rows would leak across specs.
  // Drop them here, plus the explicit child link tables to be defensive.
  await prisma.$executeRawUnsafe(
    `TRUNCATE systems, system_vendors, item_vendors, service_record_targets, warranty_targets, reminder_targets RESTART IDENTITY CASCADE`,
  );
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function createSystem(
  page: import('@playwright/test').Page,
  opts: { name: string; kind?: string; installDate?: string },
): Promise<string> {
  await page.goto('/systems/new');
  await page.getByLabel('Name').fill(opts.name);
  if (opts.kind) await page.getByLabel('Kind').fill(opts.kind);
  if (opts.installDate) await page.getByLabel('Install date').fill(opts.installDate);
  await page.getByRole('button', { name: 'Create system' }).click();
  await expect(page).toHaveURL(/\/systems\/c[a-z0-9]+$/);
  const m = page.url().match(/\/systems\/(c[a-z0-9]+)$/);
  if (!m) throw new Error(`expected /systems/<id>, got ${page.url()}`);
  return m[1];
}

async function createItem(
  page: import('@playwright/test').Page,
  opts: { name: string; categoryName?: RegExp; systemName?: string },
): Promise<string> {
  await page.goto('/items/new');
  await page.getByLabel('Name').fill(opts.name);
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: opts.categoryName ?? /HVAC/i }).click();
  if (opts.systemName) {
    await page.getByTestId('item-form-system-trigger').click();
    await page.getByRole('option', { name: opts.systemName }).click();
  }
  await page.getByRole('button', { name: 'Create item' }).click();
  // Skip past the post-create suggest interstitial.
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  const m = page.url().match(/\/items\/(c[a-z0-9]+)$/);
  if (!m) throw new Error(`expected /items/<id>, got ${page.url()}`);
  return m[1];
}

// ─── Test 1: Multi-target service record via auto-expand ─────────────────────

test('logs a service record on a system and dedupes across system + components', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  const systemId = await createSystem(page, {
    name: 'HVAC Test',
    kind: 'HVAC',
    installDate: '2026-01-15',
  });
  const heatPumpId = await createItem(page, { name: 'Heat Pump Test', systemName: 'HVAC Test' });
  const furnaceId = await createItem(page, { name: 'Furnace Test', systemName: 'HVAC Test' });

  // Verify in the DB that both items are wired into the system. UI state on
  // /systems/<id> can be cache-stale right after creation; the DB is canonical.
  const componentRows = await prisma.item.findMany({
    where: { id: { in: [heatPumpId, furnaceId] } },
    select: { id: true, systemId: true },
  });
  expect(componentRows.every((c) => c.systemId === systemId)).toBe(true);

  // The system page does not host an inline "Add service record" button; the
  // auto-expand path is exercised by navigating to /service/new?systemId=<id>,
  // which the system page links into via its add-service entry points.
  await page.goto(`/service/new?systemId=${systemId}`);

  // The targets-picker is pre-seeded with the system + both component items.
  const chips = page.getByTestId('targets-picker-chips');
  await expect(chips).toBeVisible();
  await expect(chips.getByText('System: HVAC Test')).toBeVisible();
  await expect(chips.getByText('Heat Pump Test')).toBeVisible();
  await expect(chips.getByText('Furnace Test')).toBeVisible();

  await page.getByLabel('Performed on').fill('2026-04-01');
  await page.getByLabel('Summary').fill('Spring tune-up');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page).toHaveURL(/\/service\/c[a-z0-9]+$/, { timeout: 60_000 });
  const serviceRecordId = page.url().match(/\/service\/(c[a-z0-9]+)$/)?.[1];
  if (!serviceRecordId) throw new Error('service record id not found in URL');

  // Backend state: the auto-expand wrote one ServiceRecord with three targets
  // (system + both items). One row + three target rows = correct dedupe shape.
  const targets = await prisma.serviceRecordTarget.findMany({
    where: { serviceRecordId },
    select: { itemId: true, systemId: true },
  });
  expect(targets).toHaveLength(3);
  expect(targets.some((t) => t.systemId === systemId)).toBe(true);
  expect(targets.some((t) => t.itemId === heatPumpId)).toBe(true);
  expect(targets.some((t) => t.itemId === furnaceId)).toBe(true);

  // The same record appears on the component item's Service tab — confirms the
  // record is reachable from item-side queries (item detail → service tab).
  await page.goto(`/items/${heatPumpId}?tab=service`);
  await expect(page.locator('text=Spring tune-up')).toBeVisible();
});

// ─── Test 2: Per-target reminder completion ─────────────────────────────────

test('per-target reminder completion advances only the checked targets', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  const itemAId = await createItem(page, { name: 'Item A' });
  const itemBId = await createItem(page, { name: 'Item B' });

  // Create a reminder targeting both items, due in the past.
  await page.goto('/reminders/new');
  await page.getByLabel('Title').fill('Filter Replacement');
  // Pick both items in the targets picker.
  await page.locator(`label[for="targets-item-${itemAId}"]`).click();
  await page.locator(`label[for="targets-item-${itemBId}"]`).click();
  await page.getByLabel('First due date').fill('2026-03-01');
  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);
  const reminderId = page.url().match(/\/reminders\/(c[a-z0-9]+)$/)?.[1];
  if (!reminderId) throw new Error('reminder id not found in URL');

  // Capture per-target initial nextDueOn values for later comparison.
  const initial = await prisma.reminderTarget.findMany({
    where: { reminderId },
    select: { id: true, itemId: true, nextDueOn: true },
  });
  const targetA = initial.find((t) => t.itemId === itemAId);
  const targetB = initial.find((t) => t.itemId === itemBId);
  expect(targetA).toBeTruthy();
  expect(targetB).toBeTruthy();

  // Open the multi-target dialog, uncheck Item B, submit.
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText('Mark complete: Filter Replacement')).toBeVisible();
  // Both targets pre-checked. Uncheck B by clicking its label (the checkbox
  // input itself sits behind the dialog overlay; the label receives clicks).
  await page.locator(`label[for="mark-complete-target-${targetB?.id}"]`).click();
  await page.getByRole('button', { name: 'Save completion' }).click();

  // Backend state: exactly one ReminderCompletion was written, for target A.
  await expect.poll(async () => prisma.reminderCompletion.count({ where: { reminderId } })).toBe(1);
  const completions = await prisma.reminderCompletion.findMany({ where: { reminderId } });
  expect(completions[0].targetId).toBe(targetA?.id);

  // Target A advanced; target B unchanged.
  const after = await prisma.reminderTarget.findMany({
    where: { reminderId },
    select: { id: true, itemId: true, nextDueOn: true, lastCompletedOn: true },
  });
  const afterA = after.find((t) => t.itemId === itemAId);
  const afterB = after.find((t) => t.itemId === itemBId);
  expect(afterA?.lastCompletedOn).not.toBeNull();
  // afterA's nextDueOn moved (default recurrence is interval/60 → future).
  expect(afterA?.nextDueOn?.getTime()).toBeGreaterThan(targetA?.nextDueOn?.getTime() ?? 0);
  expect(afterB?.lastCompletedOn).toBeNull();
  expect(afterB?.nextDueOn?.getTime()).toBe(targetB?.nextDueOn?.getTime());

  // UI: history card shows one completion.
  await page.goto(`/reminders/${reminderId}`);
  await expect(page.getByText(/History \(1\)/)).toBeVisible();
});

// ─── Test 3: Vendor link round-trip ─────────────────────────────────────────

test('vendor link round-trip: create, render on both sides, convert-to-freeform', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // Create a vendor.
  await page.goto('/vendors/new');
  await page.getByLabel('Name').fill('Acme HVAC');
  await page.getByRole('button', { name: /Create vendor|Save/i }).click();
  await expect(page).toHaveURL(/\/vendors\/c[a-z0-9]+$/);
  const vendorId = page.url().match(/\/vendors\/(c[a-z0-9]+)$/)?.[1];
  if (!vendorId) throw new Error('vendor id not found in URL');

  // Create an item.
  const itemId = await createItem(page, { name: 'Test Boiler' });

  // Add an ItemVendor link with role PURCHASE → Acme HVAC.
  await page.goto(`/items/${itemId}`);
  await page.getByTestId('item-vendors-add-trigger').click();
  // Default mode is "existing"; pick the vendor.
  await page.getByLabel('Vendor', { exact: true }).click();
  await page.getByRole('option', { name: 'Acme HVAC' }).click();
  await page.getByLabel('Role').click();
  await page.getByRole('option', { name: 'PURCHASE', exact: true }).click();
  await page.getByTestId('item-vendors-save').click();
  await expect(page.getByTestId('vendor-link-chips').getByText('Acme HVAC')).toBeVisible();

  // Add a freeform MANUFACTURER link.
  await page.getByTestId('item-vendors-add-trigger').click();
  await page.getByRole('tab', { name: 'Free text' }).click();
  await page.getByLabel('Vendor name').fill('LG Electronics');
  await page.getByLabel('Role').click();
  await page.getByRole('option', { name: 'MANUFACTURER', exact: true }).click();
  await page.getByTestId('item-vendors-save').click();
  await expect(page.getByTestId('vendor-link-chips').getByText('LG Electronics')).toBeVisible();

  // Both chips render with role badges.
  const chips = page.getByTestId('vendor-link-chips');
  await expect(chips.getByText('PURCHASE').first()).toBeVisible();
  await expect(chips.getByText('MANUFACTURER').first()).toBeVisible();

  // Vendor detail shows the linked item under the Purchase role section.
  // PR #86 unified the previous "Linked items" + "Linked systems" cards into
  // one "Linked items & systems" section grouped by role.
  await page.goto(`/vendors/${vendorId}`);
  await page.getByRole('tab', { name: 'Links' }).click();
  await expect(page.getByText(/Linked items & systems/)).toBeVisible();
  await expect(page.getByTestId('vendor-links').getByText('Test Boiler')).toBeVisible();

  // Open delete dialog: it should show "1 item is linked".
  await page.getByRole('button', { name: 'Delete vendor', exact: true }).click();
  const dialog = page.getByTestId('delete-vendor-has-links');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/1 item is linked/)).toBeVisible();

  // Convert to free-text.
  await page.getByTestId('delete-vendor-convert').click();
  await expect(page).toHaveURL(/\/vendors\/?$/);
  // Vendor no longer present in the list.
  await expect(page.locator('text=Acme HVAC')).toHaveCount(0);

  // Item page: the previously-linked chip now renders as freeform text (no link).
  await page.goto(`/items/${itemId}`);
  const links = await prisma.itemVendor.findMany({ where: { itemId } });
  const acmeLink = links.find((l) => l.freeformName === 'Acme HVAC');
  const lgLink = links.find((l) => l.freeformName === 'LG Electronics');
  expect(acmeLink).toBeTruthy();
  expect(acmeLink?.vendorId).toBeNull();
  expect(lgLink).toBeTruthy();
  // Acme chip is now plain text, not a link.
  if (acmeLink) {
    await expect(page.getByTestId(`vendor-link-chip-text-${acmeLink.id}`)).toHaveText('Acme HVAC');
    await expect(page.getByTestId(`vendor-link-chip-link-${acmeLink.id}`)).toHaveCount(0);
  }
});

// ─── Test 4: System archive flow ────────────────────────────────────────────

test('archive flow: system disappears from active, items keep systemId, restore reappears', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  const systemId = await createSystem(page, {
    name: 'Archive Target System',
    kind: 'Plumbing',
  });
  const itemAId = await createItem(page, {
    name: 'Linked Item A',
    systemName: 'Archive Target System',
  });
  const itemBId = await createItem(page, {
    name: 'Linked Item B',
    systemName: 'Archive Target System',
  });

  // Sanity: both items wired in, before archive.
  const before = await prisma.item.findMany({
    where: { id: { in: [itemAId, itemBId] } },
    select: { id: true, systemId: true },
  });
  expect(before.every((c) => c.systemId === systemId)).toBe(true);

  // Archive via the system header.
  await page.goto(`/systems/${systemId}`);
  await page.getByRole('button', { name: 'Archive' }).click();
  // Header swaps to "Archived <date>" badge once the action completes.
  await expect(
    page.getByText(/Archived (?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/),
  ).toBeVisible();

  // Active list omits the archived system.
  await page.goto('/systems');
  await expect(page.getByRole('link', { name: 'Archive Target System' })).toHaveCount(0);

  // Items still have systemId set (per corrected spec semantics).
  const afterArchive = await prisma.item.findMany({
    where: { id: { in: [itemAId, itemBId] } },
    select: { id: true, systemId: true },
  });
  expect(afterArchive.every((c) => c.systemId === systemId)).toBe(true);

  // Archived view shows the system.
  await page.goto('/systems?archived=true');
  await expect(page.getByRole('link', { name: 'Archive Target System' })).toBeVisible();

  // Unarchive via header (label is "Restore").
  await page.goto(`/systems/${systemId}`);
  await page.getByRole('button', { name: 'Restore' }).click();
  // Wait for the archived badge to disappear.
  await expect(
    page.getByText(/Archived (?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/),
  ).toHaveCount(0);

  // Active list includes the system again.
  await page.goto('/systems');
  await expect(page.getByRole('link', { name: 'Archive Target System' })).toBeVisible();
});

// ─── Test 5: Vendor delete-and-links cascade round-trip ─────────────────────

test('vendor cascade delete: removes vendor + ItemVendor + SystemVendor links cleanly', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // Vendor.
  await page.goto('/vendors/new');
  await page.getByLabel('Name').fill('Cascade Vendor Co');
  await page.getByRole('button', { name: /Create vendor|Save/i }).click();
  await expect(page).toHaveURL(/\/vendors\/c[a-z0-9]+$/);
  const vendorId = page.url().match(/\/vendors\/(c[a-z0-9]+)$/)?.[1];
  if (!vendorId) throw new Error('vendor id not found in URL');

  // System (for the SystemVendor link).
  const systemId = await createSystem(page, { name: 'Cascade System' });

  // Item (for the ItemVendor link).
  const itemId = await createItem(page, { name: 'Cascade Item' });

  // ItemVendor link with role SERVICE.
  await page.goto(`/items/${itemId}`);
  await page.getByTestId('item-vendors-add-trigger').click();
  await expect(page.getByTestId('vendor-link-editor')).toBeVisible();
  await page.getByTestId('vendor-link-editor').getByLabel('Vendor', { exact: true }).click();
  await page.getByRole('option', { name: 'Cascade Vendor Co' }).click();
  await page.getByTestId('vendor-link-editor').getByLabel('Role').click();
  await page.getByRole('option', { name: 'SERVICE', exact: true }).click();
  await page.getByTestId('item-vendors-save').click();
  await expect(page.getByTestId('vendor-link-chips').getByText('Cascade Vendor Co')).toBeVisible();

  // SystemVendor link with role INSTALLER on the separate system.
  await page.goto(`/systems/${systemId}`);
  await page.getByTestId('system-vendors-add-trigger').click();
  await expect(page.getByTestId('vendor-link-editor')).toBeVisible();
  await page.getByTestId('vendor-link-editor').getByLabel('Vendor', { exact: true }).click();
  await page.getByRole('option', { name: 'Cascade Vendor Co' }).click();
  await page.getByTestId('vendor-link-editor').getByLabel('Role').click();
  await page.getByRole('option', { name: 'INSTALLER', exact: true }).click();
  await page.getByTestId('system-vendors-save').click();
  await expect(page.getByTestId('vendor-link-chips').getByText('Cascade Vendor Co')).toBeVisible();

  // Sanity: link counts before delete.
  const itemLinksBefore = await prisma.itemVendor.count({ where: { vendorId } });
  const systemLinksBefore = await prisma.systemVendor.count({ where: { vendorId } });
  expect(itemLinksBefore).toBe(1);
  expect(systemLinksBefore).toBe(1);

  // Open vendor detail and trigger the cascade-delete path. Force a fresh
  // render — the add-link actions revalidate /items and /systems paths but
  // not /vendors/<id>, so a hard reload ensures the latest link counts are
  // read for the dialog's hasLinks branch.
  await page.goto(`/vendors/${vendorId}`);
  await page.reload();
  await page.getByTestId('delete-vendor-trigger').click();
  const dialog = page.getByTestId('delete-vendor-has-links');
  await expect(dialog).toBeVisible();
  // First click arms the double-confirm.
  await page.getByTestId('delete-vendor-cascade').click();
  await expect(page.getByTestId('delete-vendor-confirm-cascade')).toBeVisible();
  // Second click commits.
  await page.getByTestId('delete-vendor-cascade').click();
  await expect(page).toHaveURL(/\/vendors\/?$/);

  // Backend: vendor row gone, both link rows gone (no orphans).
  const vendorAfter = await prisma.vendor.findUnique({ where: { id: vendorId } });
  expect(vendorAfter).toBeNull();
  const itemLinksAfter = await prisma.itemVendor.count({ where: { vendorId } });
  const systemLinksAfter = await prisma.systemVendor.count({ where: { vendorId } });
  expect(itemLinksAfter).toBe(0);
  expect(systemLinksAfter).toBe(0);

  // No orphans left referencing the deleted vendor on either side.
  const orphanItems = await prisma.itemVendor.findMany({ where: { itemId } });
  const orphanSystems = await prisma.systemVendor.findMany({ where: { systemId } });
  expect(orphanItems).toHaveLength(0);
  expect(orphanSystems).toHaveLength(0);
});
