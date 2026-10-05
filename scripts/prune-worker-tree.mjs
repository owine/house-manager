#!/usr/bin/env node
// Prunes node_modules to the closure reachable from the worker's runtime
// entrypoints. Runs in the Docker build stage after `pnpm prune --prod`.
//
// Everything else in this design fails loudly. This is the one step that can
// produce a green build and a dead container, so it carries its own sanity
// checks — see SENTINELS and MIN_SURVIVOR_RATIO below.

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { walkWorkerGraph } from './worker-graph.mjs';

// Needed at boot but imported by nothing: web runs `prisma migrate deploy`
// and `tsx prisma/seed.ts`, neither of which appears in any import graph.
const BOOT_TOOLS = ['tsx', 'prisma'];

// Asserted present AFTER pruning, by stat-ing the resulting tree — not by
// testing membership of the computed root set, which would be vacuous for tsx
// and prisma (they are hardcoded roots above).
const SENTINELS = [
  'tsx',
  'prisma',
  '@prisma/client',
  '@prisma/adapter-pg',
  'pg-boss',
  'sharp',
  'react-dom',
];

// typescript is deliberately NOT a sentinel. It once was, on the belief that
// the Prisma CLI needs it to read prisma.config.ts at web boot. It does not:
// @prisma/config loads the file through c12 -> jiti, which strips types itself,
// and typescript is only an OPTIONAL peer of prisma. Since pnpm 12.7 (#15344)
// `pnpm prune --prod` drops a devDependency that only satisfies an optional
// peer, so the old check failed every build (#538). Verified then: with
// typescript unresolvable from prisma, `prisma validate` still loads the
// config. The end-to-end check is scripts/smoke-image.sh, which runs
// `prisma migrate deploy` in the built image.

// Catastrophe floor only. Deliberately slack: the denominator is the full
// production tree, and this design's premise is that web-only dependencies are
// a growing share of it, so this ratio drifts down over time BY DESIGN. A tight
// floor would redden an unrelated dependency PR, and the fix under time
// pressure is to loosen it — exactly the rot this is meant to prevent. The
// sentinels above are the precise check; this only catches "deleted nearly
// everything". Measured at authoring time: 272/553 = 49%.
const MIN_SURVIVOR_RATIO = 0.25;

/** Walk pnpm's .pnpm symlink graph from the given top-level package names. */
export function computeClosure({ nodeModules, roots }) {
  const store = join(nodeModules, '.pnpm');
  const keep = new Set();
  const stack = [];

  for (const root of roots) {
    const link = join(nodeModules, root);
    if (!existsSync(link)) throw new Error(`prune: root '${root}' is not installed`);
    stack.push(realpathSync(link));
  }

  while (stack.length > 0) {
    const dir = stack.pop();
    const rel = relative(store, dir);
    const entry = rel.split('/')[0];
    if (!entry || rel.startsWith('..') || keep.has(entry)) continue;
    keep.add(entry);

    const nested = join(store, entry, 'node_modules');
    let entries;
    try {
      entries = readdirSync(nested, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const p = join(nested, e.name);
      if (e.name.startsWith('@')) {
        let scoped;
        try {
          scoped = readdirSync(p, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of scoped) {
          try {
            stack.push(realpathSync(join(p, s.name)));
          } catch {
            /* dangling */
          }
        }
      } else {
        try {
          stack.push(realpathSync(p));
        } catch {
          /* dangling */
        }
      }
    }
  }
  return keep;
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* raced */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function main() {
  const root = process.cwd();
  const nodeModules = join(root, 'node_modules');
  const store = join(nodeModules, '.pnpm');

  let bareSpecifiers;
  try {
    ({ bareSpecifiers } = walkWorkerGraph({ root }));
  } catch (err) {
    // The walk throws rather than exiting so it stays testable; rendering it as
    // a clean message is this script's job.
    console.error(`prune-worker-tree: ABORTED — ${err.message}`);
    process.exit(1);
  }
  const roots = [...new Set([...bareSpecifiers.keys(), ...BOOT_TOOLS])];

  const before = readdirSync(store).filter((d) => d !== 'node_modules' && !d.endsWith('.yaml'));
  const beforeBytes = dirBytes(store);

  const keep = computeClosure({ nodeModules, roots });
  const drop = before.filter((d) => !keep.has(d));

  const ratio = keep.size / before.length;
  if (ratio < MIN_SURVIVOR_RATIO) {
    console.error(
      `prune-worker-tree: ABORTED — closure is ${keep.size}/${before.length} ` +
        `(${(ratio * 100).toFixed(0)}%), below the ${MIN_SURVIVOR_RATIO * 100}% floor.`,
    );
    console.error('The import walk has probably regressed. Pruning now would produce a');
    console.error('broken image that still builds successfully.');
    process.exit(1);
  }

  for (const d of drop) rmSync(join(store, d), { recursive: true, force: true });

  // Top-level symlinks whose targets just went away.
  for (const name of readdirSync(nodeModules)) {
    if (name === '.pnpm' || name === '.bin') continue;
    const p = join(nodeModules, name);
    if (name.startsWith('@')) {
      for (const s of readdirSync(p)) {
        if (!existsSync(join(p, s))) rmSync(join(p, s), { recursive: true, force: true });
      }
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
    } else if (!existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
    }
  }

  const missing = SENTINELS.filter((s) => !existsSync(join(nodeModules, s)));

  if (missing.length > 0) {
    console.error(
      `prune-worker-tree: FAILED — sentinels missing after prune: ${missing.join(', ')}`,
    );
    console.error(
      'These are required at runtime. The closure walk is wrong; do not ship this image.',
    );
    process.exit(1);
  }

  const afterBytes = dirBytes(store);
  const mb = (b) => (b / 1048576).toFixed(0);
  console.log(
    `prune-worker-tree: ${before.length} → ${keep.size} packages, ` +
      `${mb(beforeBytes)}MB → ${mb(afterBytes)}MB ` +
      `(dropped ${drop.length}, freed ${mb(beforeBytes - afterBytes)}MB)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
