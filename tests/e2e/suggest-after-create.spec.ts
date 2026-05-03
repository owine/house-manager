import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('post-create interstitial: shows item-saved confirmation + Skip lands on item detail', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await signIn(page);

  // Create a fresh item so we land on the interstitial.
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();

  // Land on the interstitial.
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);

  // Confirmation banner is visible.
  await expect(page.locator('text=Item saved')).toBeVisible();

  // Heading mentions the item name.
  await expect(
    page.getByRole('heading', { name: /Want maintenance reminders for Furnace/ }),
  ).toBeVisible();

  // Both CTAs are present.
  await expect(page.getByRole('button', { name: /Generate reminders/ })).toBeVisible();

  // Skip uses Button render={<Link/>}; Base UI's Button keeps role="button" even
  // when render={<Link>} produces an <a>. Try button first, fall back to link.
  const skipButton = page.getByRole('button', { name: 'Skip' });
  const skipLink = page.getByRole('link', { name: 'Skip' });
  if (await skipButton.count()) {
    await skipButton.click();
  } else {
    await skipLink.click();
  }

  // Land on the item detail page (no longer the interstitial).
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  await expect(page.locator('h1')).toContainText('Furnace');
});

test.describe('AI happy-path E2E coverage', () => {
  test.skip(
    true,
    'AI happy-path specs (Generate reminders, seasonal checklist, etc.) require a network-level Anthropic mock server. Deferred until that infrastructure is built. Coverage is provided by the integration suite and the nightly smoke test.',
  );
});
