// Every page under `app/(app)/` must gate itself. The group layout's redirect is
// not an auth boundary: Next renders layout and page segments in parallel, so a
// page with no gate of its own runs its queries and serializes its RSC payload
// into the response for an unauthenticated request (see lib/auth-guard.ts).
//
// This is a source-level check, not a behavioral one, so it pins the exact
// shape: the FIRST statement of the page's default export — and of its
// generateMetadata, which renders independently — is an awaited
// requireUser()/requireAdmin(). "Somewhere in the file" would pass a gate that
// runs after the query it is supposed to protect.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(process.cwd(), 'app');
const GROUP = join(APP, '(app)');

/** Pages deliberately outside the auth group. Each must render nothing private. */
const PUBLIC_PAGES = new Set([
  'page.tsx', // `/`: redirects to /dashboard or sign-in, renders nothing
]);

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.split(sep).at(-1) === 'page.tsx')
    .map((p) => join(dir, p))
    .sort();
}

/** Source text right after the body `{` of the function declared at `fnAt`. */
function bodyAfter(src: string, fnAt: number): string {
  let i = src.indexOf('(', fnAt);
  for (let depth = 0; ; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  for (let angle = 0; ; i++) {
    if (src[i] === '<') angle++;
    else if (src[i] === '>') angle--;
    else if (src[i] === '{' && angle === 0) return src.slice(i + 1);
  }
}

const firstStatement = (body: string) => body.trimStart().split('\n', 1)[0] ?? '';
const gateRe = (fn: string) => new RegExp(`^(const session = )?await ${fn}\\(\\);$`);

describe('app/(app) pages gate themselves', () => {
  const pages = pagesUnder(GROUP);

  it('finds the pages (guards against a vacuous pass)', () => {
    expect(pages.length).toBeGreaterThan(40);
  });

  for (const file of pages) {
    const rel = relative(GROUP, file);
    const fn = rel.startsWith(`admin${sep}`) ? 'requireAdmin' : 'requireUser';
    const src = readFileSync(file, 'utf8');

    it(`${rel}: default export starts with await ${fn}()`, () => {
      const at = src.search(/^export default async function/m);
      expect(at, 'default export must be an async function declaration').toBeGreaterThanOrEqual(0);
      expect(firstStatement(bodyAfter(src, at))).toMatch(gateRe(fn));
    });

    const metaAt = src.search(/^export async function generateMetadata/m);
    if (metaAt >= 0) {
      it(`${rel}: generateMetadata starts with await ${fn}()`, () => {
        expect(firstStatement(bodyAfter(src, metaAt))).toMatch(gateRe(fn));
      });
    }
  }
});

describe('pages outside app/(app) are deliberate', () => {
  it('only allow-listed pages live outside the auth group', () => {
    const outside = pagesUnder(APP)
      .filter((f) => !f.startsWith(GROUP + sep))
      .map((f) => relative(APP, f));
    expect(outside).toEqual([...PUBLIC_PAGES]);
  });
});
