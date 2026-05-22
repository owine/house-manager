import type { Page } from '@playwright/test';

/**
 * Layout-nit detector for Playwright. Runs a deterministic, content-agnostic
 * DOM scan that catches three classes of UI defects:
 *   - text-overflow:    inline text spilling past its container (overflow:visible, no ellipsis)
 *   - control-overflow: interactive controls (button/role=button/tab) whose text spills the box
 *   - viewport-overflow: elements whose bounding box extends past the viewport edges,
 *                       ignoring intentional horizontal scrollers
 *
 * Real callers should do `expect(offenders, formatOffenders(offenders)).toEqual([])`.
 * The crafted-DOM tests in `layout-heuristics.spec.ts` assert the offender list
 * directly to prove each rule fires.
 */
export type OffenderKind = 'text-overflow' | 'viewport-overflow' | 'control-overflow';

export type Offender = {
  kind: OffenderKind;
  selector: string;
  scrollWidth?: number;
  clientWidth?: number;
  rect?: { x: number; y: number; width: number; height: number };
};

export type AssertNoLayoutNitsOpts = {
  /** CSS selectors to skip (matched via Element.matches). */
  exclude?: string[];
  /** Pixel tolerance to absorb sub-pixel jitter. Default: 1. */
  tol?: number;
};

export async function assertNoLayoutNits(
  page: Page,
  opts: AssertNoLayoutNitsOpts = {},
): Promise<Offender[]> {
  const tol = opts.tol ?? 1;
  const exclude = opts.exclude ?? [];

  return await page.evaluate(
    ({ tol, exclude }) => {
      const CONTROL_SELECTOR = 'button, [role="button"], [role="tab"], a[role="button"]';

      function describe(el: Element): string {
        const tag = el.tagName.toLowerCase();
        const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
        const cls = (el as HTMLElement).className;
        const firstClass =
          typeof cls === 'string' && cls.trim() ? `.${cls.trim().split(/\s+/)[0]}` : '';
        return `${tag}${id}${firstClass}`;
      }

      function isExcluded(el: Element): boolean {
        for (const sel of exclude) {
          try {
            if (el.matches(sel)) return true;
          } catch {
            // ignore invalid selectors
          }
        }
        return false;
      }

      // Walk up parents; return true if any ancestor (excluding the document
      // root) is an intentional horizontal scroller. The document/body
      // shouldn't count — `overflow-x:auto` on <html> is the default-ish
      // behavior and isn't an "intentional scroller" that excuses overflow.
      function hasScrollableAncestor(el: Element): boolean {
        let cur: Element | null = el.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
          const ox = getComputedStyle(cur).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
          cur = cur.parentElement;
        }
        return false;
      }

      const offenders: Offender[] = [];
      const seen = new Set<string>(); // kind|selector|x,y,w,h dedupe key

      function push(o: Offender) {
        const r = o.rect;
        const key = `${o.kind}|${o.selector}|${r ? `${r.x},${r.y},${r.width},${r.height}` : ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        offenders.push(o);
      }

      function rectOf(el: Element) {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }

      const vw = window.innerWidth;
      const all = document.querySelectorAll('*');

      for (const el of Array.from(all)) {
        if (isExcluded(el)) continue;
        if (!(el instanceof HTMLElement)) continue;

        const style = getComputedStyle(el);
        const overflowsX = el.scrollWidth > el.clientWidth + tol;
        const hasText = (el.innerText ?? '').trim().length > 0;
        const isEllipsis = style.textOverflow === 'ellipsis';
        const overflowXVisible = style.overflowX === 'visible';

        // 1. control-overflow — interactive control's text exceeds content box
        if (overflowsX && el.matches(CONTROL_SELECTOR) && hasText) {
          push({
            kind: 'control-overflow',
            selector: describe(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            rect: rectOf(el),
          });
        }

        // 2. text-overflow — visible overflow on a text-bearing element with no ellipsis
        if (overflowsX && hasText && overflowXVisible && !isEllipsis) {
          push({
            kind: 'text-overflow',
            selector: describe(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            rect: rectOf(el),
          });
        }

        // 3. viewport-overflow — bounding box past viewport edges, unless inside
        // an intentional horizontal scroller
        const r = el.getBoundingClientRect();
        if ((r.right > vw + tol || r.left < -tol) && !hasScrollableAncestor(el)) {
          // Skip zero-sized elements (e.g. invisible spacers can shift slightly
          // off; we only care about visible boxes).
          if (r.width > 0 && r.height > 0) {
            push({
              kind: 'viewport-overflow',
              selector: describe(el),
              rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            });
          }
        }
      }

      return offenders;
    },
    { tol, exclude },
  );
}

export function formatOffenders(offs: Offender[]): string {
  if (offs.length === 0) return 'no layout nits';
  const HINTS: Record<OffenderKind, string> = {
    'text-overflow':
      'text spills past its container (overflow:visible, no text-overflow:ellipsis). ' +
      'Add `truncate`/`text-ellipsis`, `min-w-0` on flex children, or allow wrapping.',
    'control-overflow':
      'control text exceeds its content box. Allow the control to grow (`w-fit`), ' +
      'shrink the label, or use `truncate` with a fixed width.',
    'viewport-overflow':
      'element extends past the viewport. Likely a fixed width / negative margin / ' +
      'long unbreakable string. Add `max-w-full`, `overflow-x:auto` on a parent, or wrap.',
  };
  return offs
    .map((o) => {
      const r = o.rect;
      const meas: string[] = [];
      if (typeof o.scrollWidth === 'number' && typeof o.clientWidth === 'number') {
        meas.push(`scrollWidth=${o.scrollWidth} clientWidth=${o.clientWidth}`);
      }
      if (r) {
        meas.push(
          `rect={x:${r.x.toFixed(1)}, y:${r.y.toFixed(1)}, w:${r.width.toFixed(1)}, h:${r.height.toFixed(1)}}`,
        );
      }
      return `  - [${o.kind}] ${o.selector}\n    ${meas.join(' ')}\n    hint: ${HINTS[o.kind]}`;
    })
    .join('\n');
}
