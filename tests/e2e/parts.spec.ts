// Playwright E2E coverage for the parts surfaces PR 1b made reachable:
// creating a part through /parts/new, linking an existing part to a parent from
// that parent's Parts tab/card, and the delete-system prompt.
//
// The target-picker round trip (parts as reminder/service targets) is covered
// by tests/e2e/parts-targets.spec.ts — not duplicated here.
//
// Only the delete-system flow is @critical. It is the one destructive path in
// the feature: it archives rows the user never explicitly touched, it is guarded
// by a re-read inside the transaction, and it had no UI entry point at all
// before this PR. Creating and linking fail loudly and lose nothing.

import { expect, type Page, test } from '@playwright/test';
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a part from `/parts/new`, optionally pre-linked via the query string. */
async function createPart(
  page: Page,
  opts: { name: string; kindLabel?: string; parent?: `itemId=${string}` | `systemId=${string}` },
): Promise<string> {
  await page.goto(opts.parent ? `/parts/new?${opts.parent}` : '/parts/new');
  await page.getByLabel('Name').fill(opts.name);
  if (opts.kindLabel) {
    await page.getByTestId('part-form-kind-trigger').click();
    await page.getByRole('option', { name: opts.kindLabel, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Create part' }).click();
  await expect(page).toHaveURL(/\/parts\/c[a-z0-9]+$/);
  return page.url().split('/').pop() as string;
}

async function createSystem(page: Page, name: string): Promise<string> {
  await page.goto('/systems/new');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create system' }).click();
  await expect(page).toHaveURL(/\/systems\/c[a-z0-9]+$/);
  return page.url().split('/').pop() as string;
}

async function createItem(page: Page, name: string): Promise<string> {
  await page.goto('/items/new');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  // Skip past the post-create suggest interstitial.
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  return (page.url().match(/\/items\/(c[a-z0-9]+)$/) as RegExpMatchArray)[1];
}

/** Attach an already-existing part to the parent whose page is currently open. */
async function linkExistingPart(page: Page, partId: string, query: string): Promise<void> {
  await page.getByTestId('parts-link-trigger').click();
  await page.getByTestId('link-part-search').fill(query);
  await page.getByTestId(`link-part-pick-${partId}`).click();
  await page.getByTestId('link-part-confirm').click();
  await expect(page.getByTestId(`parts-row-${partId}`)).toBeVisible();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('a part created through the form lands on the parts list with its spec', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  await page.goto('/parts/new');
  await page.getByLabel('Name').fill('16x25x1 return filter');
  await page.getByTestId('part-form-kind-trigger').click();
  await page.getByRole('option', { name: 'Air filter', exact: true }).click();
  await page.getByLabel('Manufacturer').fill('Filtrete');
  await page.getByLabel('Model').fill('2200-16x25x1');
  await page.getByLabel('Typical cost').fill('21.99');
  await page.getByLabel('Pack quantity').fill('4');
  // Per-kind spec fields, rendered from `partKindConfigs` once the kind is set.
  await page.getByLabel('Nominal size').fill('16x25x1');
  await page.getByLabel('MERV').fill('11');
  await page.getByRole('button', { name: 'Add purchase link' }).click();
  await page.getByLabel('Label').fill('Home Depot');
  await page.getByLabel('URL').fill('https://www.homedepot.com/');

  await page.getByRole('button', { name: 'Create part' }).click();
  await expect(page).toHaveURL(/\/parts\/c[a-z0-9]+$/);
  const partId = page.url().split('/').pop() as string;

  await page.goto('/parts');
  await expect(page.getByRole('heading', { name: 'parts (1)' })).toBeVisible();
  const row = page.getByRole('link', { name: '16x25x1 return filter' });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('href', `/parts/${partId}`);

  // The spec blob and the re-buy columns beside it both persisted — a part that
  // saved as name-only would still pass every assertion above.
  const part = await prisma.part.findUniqueOrThrow({ where: { id: partId } });
  expect(part.kind).toBe('AIR_FILTER');
  expect(part.metadata).toMatchObject({ nominalSize: '16x25x1', merv: 11 });
  expect(Number(part.typicalCost)).toBe(21.99);
  expect(part.packQuantity).toBe(4);
  expect(part.purchaseLinks).toEqual([{ label: 'Home Depot', url: 'https://www.homedepot.com/' }]);
});

test('an existing part links to an item from its parts tab, and unlinks again', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  const itemId = await createItem(page, 'Kitchen recessed lighting');
  const partId = await createPart(page, { name: 'Kitchen can light bulb', kindLabel: 'Bulb' });

  await page.goto(`/items/${itemId}?tab=parts`);
  await expect(page.getByText('no parts linked yet.')).toBeVisible();
  await linkExistingPart(page, partId, 'can light');

  expect(await prisma.partLink.findMany({ where: { partId } })).toMatchObject([{ itemId }]);

  // Unlink drops the link row without touching the part itself.
  await page.getByTestId(`parts-unlink-${partId}`).click();
  await expect(page.getByTestId(`parts-row-${partId}`)).toBeHidden();
  expect(await prisma.partLink.count({ where: { partId } })).toBe(0);
  expect(await prisma.part.findUniqueOrThrow({ where: { id: partId } })).toMatchObject({
    archivedAt: null,
  });
});

test('deleting a system prompts for its parts and archives exactly the checked set @critical', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  const systemId = await createSystem(page, 'Central HVAC');
  const itemId = await createItem(page, 'Blower assembly');

  // Orphan-to-be: born on the system's own Parts card, so `?systemId=` create
  // + link is exercised too. Its only link points at the system.
  const orphanId = await createPart(page, {
    name: 'Furnace filter',
    kindLabel: 'Air filter',
    parent: `systemId=${systemId}`,
  });

  // Shared: linked to the system AND to an item, so losing the system must not
  // archive it.
  const sharedId = await createPart(page, { name: 'Blower belt', kindLabel: 'Belt' });
  await page.goto(`/items/${itemId}?tab=parts`);
  await linkExistingPart(page, sharedId, 'Blower belt');
  await page.goto(`/systems/${systemId}`);
  await linkExistingPart(page, sharedId, 'Blower belt');

  await expect(page.getByTestId(`parts-row-${orphanId}`)).toBeVisible();

  // The prompt: parts present, so the delete does not go straight through.
  await page.getByTestId('system-delete-trigger').click();
  await expect(page.getByRole('heading', { name: 'Delete Central HVAC?' })).toBeVisible();

  // Default-checked is `willBeOrphaned` only.
  await expect(page.getByTestId(`delete-system-part-${orphanId}`)).toBeChecked();
  await expect(page.getByTestId(`delete-system-part-${sharedId}`)).not.toBeChecked();
  // Scoped to the dialog's own labels: the Parts card behind the overlay still
  // has "Furnace filter" in the DOM, so a bare getByText would be ambiguous.
  await expect(page.locator('label', { hasText: 'Furnace filter' })).toContainText(
    'not linked to anything else',
  );
  await expect(page.locator('label', { hasText: 'Blower belt' })).toContainText(
    'still linked elsewhere',
  );

  await page.getByTestId('delete-system-confirm').click();
  await expect(page).toHaveURL(/\/systems$/);

  // The system is gone, the orphan is archived, the shared part is untouched
  // and keeps the link it still had a parent for.
  expect(await prisma.system.findUnique({ where: { id: systemId } })).toBeNull();
  const orphan = await prisma.part.findUniqueOrThrow({ where: { id: orphanId } });
  expect(orphan.archivedAt).not.toBeNull();
  const shared = await prisma.part.findUniqueOrThrow({
    where: { id: sharedId },
    include: { links: true },
  });
  expect(shared.archivedAt).toBeNull();
  expect(shared.links).toMatchObject([{ itemId, systemId: null }]);
  // Cascade took the system's link rows with it; nothing dangles.
  expect(await prisma.partLink.count({ where: { systemId } })).toBe(0);
});
