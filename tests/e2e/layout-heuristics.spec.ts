import { expect, test } from '@playwright/test';
import { assertNoLayoutNits, formatOffenders, type OffenderKind } from './layout-heuristics';

const ALL_KINDS: OffenderKind[] = ['text-overflow', 'control-overflow', 'viewport-overflow'];

// These tests prove the helper DETECTS nits using crafted DOM (data: / setContent),
// so they do NOT need the app stack — they run with the host browser only.
// In real callers, you assert `expect(offenders).toEqual([])`; here we assert
// the offender list directly to verify each detection rule.

test.describe('assertNoLayoutNits', () => {
  test('detects text/control overflow in an undersized button', async ({ page }) => {
    await page.setContent(`
      <!doctype html>
      <html><body style="margin:0">
        <button id="too-narrow" style="width:100px; overflow: visible; white-space: nowrap;">
          Supercalifragilisticexpialidocious-extra-extra-long
        </button>
      </body></html>
    `);
    const offenders = await assertNoLayoutNits(page);
    expect(offenders.length).toBeGreaterThan(0);
    const buttonOffenders = offenders.filter((o) => o.selector.includes('button'));
    expect(buttonOffenders.length).toBeGreaterThan(0);
    const kinds = new Set(buttonOffenders.map((o) => o.kind));
    // Sanity-check the kinds belong to the expected union (uses OffenderKind).
    for (const k of kinds) expect(ALL_KINDS).toContain(k);
    // Should be flagged as either text-overflow or control-overflow (or both).
    expect(
      [...kinds].some((k) => k === 'text-overflow' || k === 'control-overflow'),
      `expected text-overflow or control-overflow, got: ${[...kinds].join(',')}`,
    ).toBe(true);
    const first = buttonOffenders[0];
    expect(first.selector).toMatch(/#too-narrow|button/);
    expect(typeof first.scrollWidth).toBe('number');
    expect(typeof first.clientWidth).toBe('number');
    expect(first.rect).toBeDefined();
    expect((first.scrollWidth ?? 0) > (first.clientWidth ?? 0)).toBe(true);
  });

  test('detects viewport overflow from a too-wide div', async ({ page }) => {
    await page.setContent(`
      <!doctype html>
      <html><body style="margin:0">
        <div id="too-wide" style="width: 200vw; height: 20px; background: #f00;"></div>
      </body></html>
    `);
    const offenders = await assertNoLayoutNits(page);
    const viewportOffenders = offenders.filter((o) => o.kind === 'viewport-overflow');
    expect(viewportOffenders.length).toBeGreaterThan(0);
    const div = viewportOffenders.find((o) => o.selector.includes('#too-wide'));
    expect(
      div,
      `expected an offender for #too-wide, got: ${JSON.stringify(offenders)}`,
    ).toBeDefined();
    expect(div?.rect).toBeDefined();
    expect(div?.rect?.width ?? 0).toBeGreaterThan(0);
  });

  test('returns [] for a clean page', async ({ page }) => {
    await page.setContent(`
      <!doctype html>
      <html><body style="margin:0">
        <div>Hello</div>
      </body></html>
    `);
    const offenders = await assertNoLayoutNits(page);
    // Demonstrate the real-caller pattern: pass formatOffenders as the
    // assertion message so a failing run prints something readable.
    expect(offenders, formatOffenders(offenders)).toEqual([]);
  });
});
