import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('searches across kinds, filters by facet', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // 1) Create an item that should appear in search.
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  // Open the Category combobox and pick HVAC.
  // Was a native <select> before Plan 4ab; now shadcn <Select> (Base UI listbox).
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // 2) Wait for the search index to catch up (fire-and-forget enqueue).
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/search?q=furnace');
        if (!res.ok()) return [];
        const data = (await res.json()) as { hits: Array<{ title: string }> };
        return data.hits.map((h) => h.title);
      },
      { timeout: 10_000, intervals: [500, 1000, 1500] },
    )
    .toContain('Furnace');

  // 3) Header dropdown shows the result; click navigates to the item page.
  await page.getByPlaceholder('Search…').fill('furnace');
  await expect(page.getByRole('link', { name: /Furnace/ }).first()).toBeVisible();
  await page
    .getByRole('link', { name: /Furnace/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // 4) /search page shows the result + facet count.
  await page.goto('/search?q=furnace');
  await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();
  await expect(page.getByText(/All 1/)).toBeVisible();
});
