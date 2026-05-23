import { expect, test } from '@playwright/test';
import {
  EMPTY_ROUTES,
  populatedRoutes,
  type SeededUrls,
  seedPopulated,
  VIEWPORTS,
} from './_routes';
import { resetAuth, signIn } from './auth';
import { assertNoLayoutNits, formatOffenders } from './layout-heuristics';

// Visual + layout suite. Runs ONLY via the dockerized harness
// (`pnpm test:visual:local`) so baselines stay platform-pinned to linux. The
// macOS-native Playwright run skips this spec entirely — a baseline taken on
// darwin would diff against the linux baseline forever.
test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'Run via pnpm test:visual:local (dockerized).');

/**
 * Selectors masked out of the visual snapshot per route. Anything that
 * server-renders a relative-time or "today" cue must be masked — otherwise
 * the baseline drifts as soon as the system clock moves a day. Calendar
 * dates / ISO timestamps are stable and do not need masking.
 */
function masksForRoute(name: string): string[] {
  // Dashboard: RecentActivityList renders "5m ago" / "2d ago" per row.
  if (name === 'dashboard-populated') return ['[data-testid=recent-activity-list]'];
  // Calendar grid: the "today" cell gets a ring-2 highlight that moves daily.
  if (name === 'reminders-calendar' || name === 'reminders-calendar-populated') {
    return ['[data-testid=calendar-grid]'];
  }
  // Reminder list + detail: ReminderStatusBadge text/variant depends on
  // (dueDate - now) in days (Overdue / Due soon / In Nd).
  if (name === 'reminders-populated' || name === 'reminder-detail') {
    return ['[data-testid=reminder-due-badge]'];
  }
  return [];
}

test.describe('visual regression + layout heuristics', () => {
  test('empty-state routes', async ({ page, context }) => {
    test.setTimeout(300_000);
    await resetAuth();
    await context.clearCookies();
    await signIn(page);
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of EMPTY_ROUTES) {
        await page.goto(route.path);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        // Hard-fail if sign-in silently failed — otherwise every route would
        // redirect to /api/auth/signin, heuristics would find nothing on it,
        // and toHaveScreenshot would record the signin page 48× under route
        // names. (Asked us once already; never again.)
        expect(
          page.url(),
          `${route.name} [${vp.name}]: redirected to sign-in (auth failed)`,
        ).not.toMatch(/\/api\/auth\/signin/);
        const offenders = await assertNoLayoutNits(page);
        expect
          .soft(offenders, `${route.name} [${vp.name}] layout nits:\n${formatOffenders(offenders)}`)
          .toEqual([]);
        await expect(page).toHaveScreenshot(`${route.name}-${vp.name}.png`, {
          maxDiffPixelRatio: 0.01,
          mask: masksForRoute(route.name).map((sel) => page.locator(sel)),
        });
      }
    }
  });

  test('populated routes', async ({ page, context }) => {
    test.setTimeout(300_000);
    await resetAuth();
    await context.clearCookies();
    await signIn(page);
    const urls: SeededUrls = await seedPopulated(page);
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of populatedRoutes(urls)) {
        await page.goto(route.path);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        // Hard-fail if sign-in silently failed — otherwise every route would
        // redirect to /api/auth/signin, heuristics would find nothing on it,
        // and toHaveScreenshot would record the signin page 48× under route
        // names. (Asked us once already; never again.)
        expect(
          page.url(),
          `${route.name} [${vp.name}]: redirected to sign-in (auth failed)`,
        ).not.toMatch(/\/api\/auth\/signin/);

        // /search?q=furnace: the worker indexes the freshly-seeded item into
        // Meili asynchronously after seedPopulated returns. Wait for the
        // result row to render before snapshotting; otherwise the baseline
        // alternates between "no results" and the populated grid.
        if (route.name === 'search-furnace') {
          await page
            .getByText(/furnace/i)
            .first()
            .waitFor({ state: 'visible', timeout: 10_000 })
            .catch(() => {});
        }

        const offenders = await assertNoLayoutNits(page);
        expect
          .soft(offenders, `${route.name} [${vp.name}] layout nits:\n${formatOffenders(offenders)}`)
          .toEqual([]);
        await expect(page).toHaveScreenshot(`${route.name}-${vp.name}.png`, {
          maxDiffPixelRatio: 0.01,
          mask: masksForRoute(route.name).map((sel) => page.locator(sel)),
        });
      }
    }
  });
});
