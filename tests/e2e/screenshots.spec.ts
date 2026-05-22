import { mkdir } from 'node:fs/promises';
import { type Page, test } from '@playwright/test';
import { EMPTY_ROUTES, populatedRoutes, seedPopulated, VIEWPORTS } from './_routes';
import { resetAuth, signIn } from './auth';

const OUT_DIR = 'test-results/ui-screenshots';

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
  const urls = await seedPopulated(page, {
    onSuggestInterstitial: (p) => shoot(p, 'suggest-after-create', 'desktop'),
  });

  // Populated screenshots — list views + detail views, both viewports
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const route of populatedRoutes(urls)) {
      await page.goto(route.path);
      await shoot(page, route.name, vp.name);
    }
  }
});
