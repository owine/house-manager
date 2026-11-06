// Every page under `app/(app)/` must gate itself. The group layout's redirect is
// not an auth boundary: Next renders layout and page segments in parallel, so a
// page with no gate of its own runs its queries and serializes its RSC payload
// into the response for an unauthenticated request (see lib/auth-guard.ts).
//
// This is a source-level check, not a behavioral one, so it pins the exact
// shape: the FIRST statement of every segment file's default export (page,
// layout, template, default, in any extension) — and of its generateMetadata,
// which renders independently — is an awaited requireUser()/requireAdmin().
// "Somewhere in the file" would pass a gate that runs after the query it is
// supposed to protect. Route handlers may not live under the group at all.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(process.cwd(), 'app');
const GROUP = join(APP, '(app)');

/** Pages deliberately outside the auth group. Each must render nothing private. */
const PUBLIC_PAGES = new Set([
  'page.tsx', // `/`: redirects to /dashboard or sign-in, renders nothing
]);

// Every file Next renders as a segment, in any extension it accepts. A nested
// layout renders in parallel with the group layout exactly like a page does,
// so it leaks the same way; template/default render alongside too.
const SEGMENT_FILE = /^(page|layout|template|default)\.(t|j)sx?$/;
const PAGE_FILE = /^page\.(t|j)sx?$/;
// A route handler under the group skips every layout and every page gate.
const ROUTE_FILE = /^route\.(t|j)sx?$/;

function filesUnder(dir: string, re: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => re.test(p.split(sep).at(-1) ?? ''))
    .map((p) => join(dir, p))
    .sort();
}

/** Source text right after the body `{` of the function declared at `fnAt`. */
function bodyAfter(src: string, fnAt: number): string {
  let i = src.indexOf('(', fnAt);
  if (i < 0) throw new Error('no parameter list');
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  // Skip the return type annotation. `=>` is not a closing angle bracket.
  for (let angle = 0; i < src.length; i++) {
    if (src[i] === '<') angle++;
    else if (src[i] === '>' && src[i - 1] !== '=') angle--;
    else if (src[i] === '{' && angle === 0) return src.slice(i + 1);
  }
  throw new Error('no function body found');
}

const firstStatement = (body: string) => body.trimStart().split('\n', 1)[0] ?? '';
const gateRe = (fn: string) => new RegExp(`^(const session = )?await ${fn}\\(\\);$`);

describe('app/(app) segments gate themselves', () => {
  const segments = filesUnder(GROUP, SEGMENT_FILE);

  it('finds the pages (guards against a vacuous pass)', () => {
    expect(
      segments.filter((f) => PAGE_FILE.test(f.split(sep).at(-1) ?? '')).length,
    ).toBeGreaterThan(40);
  });

  it('has no route handlers (they bypass every layout and page gate)', () => {
    expect(filesUnder(GROUP, ROUTE_FILE).map((f) => relative(GROUP, f))).toEqual([]);
  });

  for (const file of segments) {
    const rel = relative(GROUP, file);
    const fn = rel.startsWith(`admin${sep}`) ? 'requireAdmin' : 'requireUser';
    const src = readFileSync(file, 'utf8');
    // Comments stripped, so a mention in prose is not taken for code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it(`${rel}: default export starts with await ${fn}()`, () => {
      const at = src.search(/^export default async function/m);
      expect(at, 'default export must be an async function declaration').toBeGreaterThanOrEqual(0);
      expect(firstStatement(bodyAfter(src, at))).toMatch(gateRe(fn));
    });

    // Any generateMetadata must be the one shape checked below; an arrow or
    // re-exported form would otherwise run ungated without failing anything.
    if (/generateMetadata/.test(code)) {
      it(`${rel}: generateMetadata is a function declaration starting with await ${fn}()`, () => {
        const metaAt = src.search(/^export async function generateMetadata\b/m);
        expect(
          metaAt,
          'declare it as `export async function generateMetadata`',
        ).toBeGreaterThanOrEqual(0);
        expect(code.match(/generateMetadata/g)?.length, 'one generateMetadata only').toBe(1);
        expect(firstStatement(bodyAfter(src, metaAt))).toMatch(gateRe(fn));
      });
    }
  }
});

describe('pages outside app/(app) are deliberate', () => {
  it('only allow-listed pages live outside the auth group', () => {
    const outside = filesUnder(APP, PAGE_FILE)
      .filter((f) => !f.startsWith(GROUP + sep))
      .map((f) => relative(APP, f));
    expect(outside).toEqual([...PUBLIC_PAGES]);
  });
});
