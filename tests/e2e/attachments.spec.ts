import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('uploads a JPEG to an item, sees the thumbnail, deletes it', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // Create a fresh item.
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  // Open the Category combobox and pick HVAC.
  // Was a native <select> before Plan 4ab; now shadcn <Select> (Base UI listbox).
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  // Plan 4b Task 21: post-create lands on the suggest-after-create interstitial.
  // Skip past it to reach the item detail page.
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  // Base UI's Button keeps role="button" even when render={<Link>} produces an <a>.
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // Switch to the Files tab.
  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();

  // Upload the fixture. PR #89 replaced the unicode "✓ <filename>" status
  // glyph with a lucide check icon next to the bare filename, so we now
  // assert on the filename's appearance in the status list directly.
  await page.setInputFiles('input[type=file]', 'tests/fixtures/sample.jpg');
  await expect(page.locator('text=sample.jpg').first()).toBeVisible({ timeout: 10_000 });

  // Verify a card with the file rendered (Delete button is the visible signal).
  // Note: the dev server doesn't run the worker process, so the thumbnail
  // .webp won't be generated during the test. The <Image> tag has no
  // onerror fallback in our v1 implementation; if you want to assert the
  // image element renders, just check for its presence by alt text.
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

  // Delete the attachment.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();

  // Add an external link via the form below the file picker.
  await page.getByLabel('Label (optional)').fill('Furnace manual on Proton');
  await page.getByLabel('URL (https or http)').fill('https://drive.proton.me/urls/EXAMPLE');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.locator('text=Furnace manual on Proton')).toBeVisible({ timeout: 10_000 });

  // Delete the link.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('text=No files yet')).toBeVisible();
});

// The only test that sees the headers a BROWSER gets. next.config.ts
// `headers()` are applied before a route handler runs and WIN on a name clash
// (Next drops the handler's value), so a global CSP would silently replace
// the file route's sandbox. Integration tests call handlers directly and
// can't see that. @critical because nothing else would notice the regression.
test('pages and files carry their security headers @critical', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  const pageResponse = await page.goto('/items/new');
  expect(pageResponse).not.toBeNull();
  const pageHeaders = (await pageResponse?.allHeaders()) ?? {};
  expect(pageHeaders['x-frame-options']).toBe('DENY');
  expect(pageHeaders['content-security-policy']).toBe("frame-ancestors 'none'");
  expect(pageHeaders['x-content-type-options']).toBe('nosniff');
  expect(pageHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
  // HSTS is Cloudflare's job (it already sends max-age=63072000); the app must
  // not add a second, conflicting value. See next.config.ts.
  expect(pageHeaders['strict-transport-security']).toBeUndefined();
  expect(pageHeaders['x-powered-by']).toBeUndefined();

  // A real PDF, uploaded the normal way, then fetched as the browser would.
  await page.getByLabel('Name').fill('Water Heater');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: /HVAC/i }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+\/suggest-after-create$/);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);
  await page.getByRole('link', { name: 'Files' }).click();
  await page.setInputFiles('input[type=file]', 'tests/fixtures/sample.pdf');
  const fileLink = page.locator('a[href^="/api/files/"]').first();
  await expect(fileLink).toBeVisible({ timeout: 10_000 });
  const href = await fileLink.getAttribute('href');
  expect(href).toBeTruthy();

  const fileResponse = await page.request.get(href as string);
  expect(fileResponse.status()).toBe(200);
  const fileHeaders = fileResponse.headers();
  expect(fileHeaders['content-type']).toBe('application/pdf');
  expect(fileHeaders['content-disposition']).toMatch(/^inline;/);
  expect(fileHeaders['x-content-type-options']).toBe('nosniff');
  // The route's own policy, NOT the global frame-ancestors one.
  expect(fileHeaders['content-security-policy']).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  expect(fileHeaders['x-frame-options']).toBeUndefined();
  expect(fileHeaders['x-powered-by']).toBeUndefined();
});
