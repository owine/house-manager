import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  EMPTY_ROUTES,
  populatedRoutes,
  type SeededUrls,
  seedPopulated,
  VIEWPORTS,
} from './_routes';
import { A11Y_EXCLUDED_RULES } from './a11y-exclusions';
import { resetAuth, signIn } from './auth';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, label: string) {
  await page.waitForLoadState('domcontentloaded');
  // Let client components hydrate before scanning — otherwise axe can race a
  // pre-hydration DOM (e.g. label/aria associations not yet wired) and flag
  // spurious violations. networkidle is best-effort (the dev-server HMR socket
  // keeps the network busy), so cap it and move on.
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(page.url(), `${label}: redirected to sign-in`).not.toMatch(/\/api\/auth\/signin/);

  let builder = new AxeBuilder({ page }).withTags(WCAG_AA);
  if (A11Y_EXCLUDED_RULES.length > 0) builder = builder.disableRules(A11Y_EXCLUDED_RULES);
  const { violations } = await builder.analyze();

  const summary = violations
    .map(
      (v) =>
        `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n    ${v.helpUrl}\n    ${v.nodes
          .map((n) => n.target.join(' '))
          .join('\n    ')}`,
    )
    .join('\n');
  // Soft so a single run reports EVERY route's violations (not just the first),
  // while still failing the test. Better for both measurement and gate triage.
  expect.soft(violations, `${label} a11y violations:\n${summary}`).toEqual([]);
}

test.describe('accessibility (WCAG 2.1 AA)', () => {
  test('empty-state routes', async ({ page, context }) => {
    test.setTimeout(300_000);
    await resetAuth();
    await context.clearCookies();
    await signIn(page);
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of EMPTY_ROUTES) {
        await page.goto(route.path);
        await scan(page, `${route.name} [${vp.name}]`);
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
        await scan(page, `${route.name} [${vp.name}]`);
      }
    }
  });
});
