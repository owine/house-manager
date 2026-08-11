import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — untyped .mjs; allowJs is false so TS2307 always fires here
const { computeClosure } = await import('../../scripts/prune-worker-tree.mjs');

let nodeModules: string;
let store: string;

/**
 * Create a store entry `.pnpm/<entry>/node_modules/<pkg>`.
 * `entry` is pnpm's flattened dir name (`a@1.0.0`, `@scope+pkg@1.0.0`);
 * `pkg` is the real package name (`a`, `@scope/pkg`).
 */
function storeEntry(entry: string, pkg: string): void {
  mkdirSync(join(store, entry, 'node_modules', pkg), { recursive: true });
}

/** Top-level `node_modules/<pkg>` symlink into the store. */
function topLevel(pkg: string, entry: string): void {
  const link = join(nodeModules, pkg);
  mkdirSync(dirname(link), { recursive: true });
  // Relative from node_modules/<pkg>'s own dir; scoped links sit one level deeper.
  const up = pkg.startsWith('@') ? '../.pnpm' : '.pnpm';
  symlinkSync(join(up, entry, 'node_modules', pkg), link, 'dir');
}

/**
 * Nested dependency symlink inside a store entry:
 * `.pnpm/<fromEntry>/node_modules/<pkg> -> ../../<toEntry>/node_modules/<pkg>`.
 *
 * Two `..` for a bare name, three for a scoped one — both land at `.pnpm/`,
 * which is where sibling store entries live. This mirrors the real tree:
 *   node_modules/.pnpm/pg-boss@*&#47;node_modules/pg -> ../../pg@8.22.0/node_modules/pg
 */
function nestedDep(fromEntry: string, toEntry: string, pkg: string): void {
  const link = join(store, fromEntry, 'node_modules', pkg);
  mkdirSync(dirname(link), { recursive: true });
  const up = pkg.startsWith('@') ? '../../..' : '../..';
  symlinkSync(join(up, toEntry, 'node_modules', pkg), link, 'dir');
}

function closure(roots: string[]): Set<string> {
  return computeClosure({ nodeModules, roots }) as Set<string>;
}

beforeEach(() => {
  // realpath the temp root: on macOS os.tmpdir() is /var/... which is itself a
  // symlink to /private/var/..., and computeClosure compares realpathSync()
  // output against the store path. Without this every entry looks outside the
  // store and the closure comes back empty.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prune-worker-tree-')));
  nodeModules = join(root, 'node_modules');
  store = join(nodeModules, '.pnpm');
  mkdirSync(store, { recursive: true });
});

afterEach(() => {
  rmSync(dirname(nodeModules), { recursive: true, force: true });
});

describe('computeClosure', () => {
  it('reaches transitive deps through nested symlinks and excludes orphans', () => {
    storeEntry('a@1.0.0', 'a');
    storeEntry('b@1.0.0', 'b');
    storeEntry('orphan@1.0.0', 'orphan');
    topLevel('a', 'a@1.0.0');
    topLevel('orphan', 'orphan@1.0.0');
    nestedDep('a@1.0.0', 'b@1.0.0', 'b');

    const keep = closure(['a']);

    expect([...keep].sort()).toEqual(['a@1.0.0', 'b@1.0.0']);
    expect(keep.has('orphan@1.0.0')).toBe(false);
  });

  it('follows scoped packages as roots and as nested deps', () => {
    storeEntry('@scope+pkg@1.0.0', '@scope/pkg');
    storeEntry('@scope+dep@2.0.0', '@scope/dep');
    storeEntry('plain@1.0.0', 'plain');
    storeEntry('orphan@1.0.0', 'orphan');
    topLevel('@scope/pkg', '@scope+pkg@1.0.0');
    nestedDep('@scope+pkg@1.0.0', '@scope+dep@2.0.0', '@scope/dep');
    nestedDep('@scope+dep@2.0.0', 'plain@1.0.0', 'plain');

    const keep = closure(['@scope/pkg']);

    expect([...keep].sort()).toEqual(['@scope+dep@2.0.0', '@scope+pkg@1.0.0', 'plain@1.0.0']);
    expect(keep.has('orphan@1.0.0')).toBe(false);
  });

  it('throws when a root is not installed rather than silently skipping it', () => {
    storeEntry('a@1.0.0', 'a');
    topLevel('a', 'a@1.0.0');

    expect(() => closure(['a', 'ghost'])).toThrow(/root 'ghost' is not installed/);
  });

  it('terminates on cycles', () => {
    storeEntry('a@1.0.0', 'a');
    storeEntry('b@1.0.0', 'b');
    topLevel('a', 'a@1.0.0');
    nestedDep('a@1.0.0', 'b@1.0.0', 'b');
    nestedDep('b@1.0.0', 'a@1.0.0', 'a');

    expect([...closure(['a'])].sort()).toEqual(['a@1.0.0', 'b@1.0.0']);
  });

  it('unions the closures of multiple roots', () => {
    storeEntry('a@1.0.0', 'a');
    storeEntry('b@1.0.0', 'b');
    storeEntry('c@1.0.0', 'c');
    storeEntry('shared@1.0.0', 'shared');
    storeEntry('orphan@1.0.0', 'orphan');
    topLevel('a', 'a@1.0.0');
    topLevel('c', 'c@1.0.0');
    nestedDep('a@1.0.0', 'b@1.0.0', 'b');
    nestedDep('b@1.0.0', 'shared@1.0.0', 'shared');
    nestedDep('c@1.0.0', 'shared@1.0.0', 'shared');

    const keep = closure(['a', 'c']);

    expect([...keep].sort()).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'shared@1.0.0']);
  });

  it('survives a dangling nested symlink without dragging in unrelated entries', () => {
    storeEntry('a@1.0.0', 'a');
    storeEntry('b@1.0.0', 'b');
    storeEntry('orphan@1.0.0', 'orphan');
    topLevel('a', 'a@1.0.0');
    nestedDep('a@1.0.0', 'b@1.0.0', 'b');
    nestedDep('a@1.0.0', 'gone@9.9.9', 'gone');

    expect([...closure(['a'])].sort()).toEqual(['a@1.0.0', 'b@1.0.0']);
  });
});
