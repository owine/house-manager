#!/usr/bin/env node
// Asserts that every module the worker can reach at runtime actually ships in
// the worker's runtime image.
//
// The worker runs under `tsx` with no compile step, so the `@/` alias is
// resolved from tsconfig.json *at boot* against whatever files the final
// Docker stage happens to contain. That makes the import graph and the
// Dockerfile's COPY list two halves of one contract that nothing else checks:
// `tsc --noEmit` resolves against the full source tree, `next build` bundles
// its own copy, and unit tests run from the repo root. All three stay green
// while the container dies on `ERR_MODULE_NOT_FOUND` at startup.
//
// That is not hypothetical — it took the worker down for five days. #333 added
// `lib/embedding/canonicalize.ts` → `@/components/parts/kind-labels`, and
// `components/` is not copied into the runtime stage. Every scheduled job
// (backups, reminder notifications, digests, chore auto-complete, search
// reindex, embedding backfill) stopped, silently, with a healthy web container
// sitting next to it.
//
// Rather than hardcode "lib/ must not import components/", this walks the real
// transitive graph from the worker entrypoint and checks each hop against the
// COPY lines parsed out of the Dockerfile — so it keeps working when either
// side changes.
//
// Limitations:
//  - Regex-based specifier extraction, not a real parser. Import specifiers
//    are string literals in practice; a fully dynamic `import(someVar)` is
//    invisible here (there are none today).
//  - Only checks presence of the *file*, not that every named export exists.
//    tsc already covers that.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const DOCKERFILE = join(ROOT, 'Dockerfile');
const ENTRYPOINTS = ['worker/index.ts'];

// Extensions tsx/tsc will try, in resolution order.
const EXTS = ['.ts', '.tsx', '.mjs', '.js', '.json'];
const INDEXES = EXTS.map((ext) => `index${ext}`);

// `import x from 'y'`, `export * from 'y'`, `import('y')`, `require('y')`
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Parse the runtime stage's COPY targets out of the Dockerfile. */
function runtimePaths() {
  const text = readFileSync(DOCKERFILE, 'utf8');
  const paths = new Set();
  // `COPY --from=<stage> /app/<src> ./<dest>` — we care about the destination,
  // which is always the repo-relative path the runtime image will serve.
  for (const m of text.matchAll(/^COPY\s+--from=\S+\s+\S+\s+\.\/(\S+)\s*$/gm)) {
    paths.add(m[1].replace(/\/$/, ''));
  }
  if (paths.size === 0) {
    console.error('lint:worker-graph — parsed zero COPY targets from the Dockerfile.');
    console.error('The Dockerfile format changed; update the regex in this script.');
    process.exit(1);
  }
  return paths;
}

const RUNTIME_PATHS = runtimePaths();

/** Is this repo-relative path inside something the runtime image copies? */
function shipsInRuntimeImage(relPath) {
  for (const p of RUNTIME_PATHS) {
    if (relPath === p || relPath.startsWith(`${p}/`)) return true;
  }
  return false;
}

/** Resolve a specifier to an on-disk file, or null if it is a bare package. */
function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // bare package — lives in node_modules, which is copied

  // Exact hit (an explicit extension was written).
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const index of INDEXES) {
    const candidate = join(base, index);
    if (existsSync(candidate)) return candidate;
  }
  return { unresolved: base };
}

const visited = new Set();
/** @type {Array<{importer: string, specifier: string, target: string}>} */
const violations = [];
/** @type {Array<{importer: string, specifier: string}>} */
const unresolved = [];

function walk(file) {
  if (visited.has(file)) return;
  visited.add(file);

  const text = readFileSync(file, 'utf8')
    // Strip comments so commented-out or documented imports don't count.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const m of text.matchAll(SPECIFIER_RE)) {
    const spec = m[1];
    const resolved = resolveSpecifier(spec, file);
    if (resolved === null) continue;

    const importer = relative(ROOT, file);
    if (typeof resolved === 'object') {
      unresolved.push({ importer, specifier: spec });
      continue;
    }

    const target = relative(ROOT, resolved);
    if (!shipsInRuntimeImage(target)) {
      violations.push({ importer, specifier: spec, target });
      continue; // don't recurse into a file that won't exist at runtime
    }
    walk(resolved);
  }
}

for (const entry of ENTRYPOINTS) {
  const path = join(ROOT, entry);
  if (!existsSync(path)) {
    console.error(`lint:worker-graph — entrypoint ${entry} not found.`);
    process.exit(1);
  }
  walk(path);
}

if (unresolved.length > 0) {
  console.error(`lint:worker-graph — ${unresolved.length} specifier(s) could not be resolved:\n`);
  for (const { importer, specifier } of unresolved) {
    console.error(`  ${importer}  →  ${specifier}`);
  }
  process.exit(1);
}

if (violations.length === 0) {
  console.log(
    `lint:worker-graph — OK (${visited.size} modules reachable from the worker, all present in the runtime image)`,
  );
  process.exit(0);
}

console.error(
  `lint:worker-graph — ${violations.length} module(s) reachable from the worker are NOT copied into the runtime image:\n`,
);
for (const { importer, specifier, target } of violations) {
  console.error(`  ${importer}`);
  console.error(`    imports ${specifier}  →  ${target}`);
}
console.error('\nThe worker resolves `@/` at runtime, so this crashes the container at boot with');
console.error('ERR_MODULE_NOT_FOUND while lint, typecheck, tests and `next build` all pass.');
console.error('\nFix by either:');
console.error('  - moving the shared code under lib/ (preferred — it is the layer both sides');
console.error('    already depend on), or');
console.error('  - adding a COPY for it to the runtime stage in the Dockerfile.');
process.exit(1);
