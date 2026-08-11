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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRYPOINTS, walkWorkerGraph } from './worker-graph.mjs';

const ROOT = process.cwd();
const DOCKERFILE = join(ROOT, 'Dockerfile');

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

let files;
let bareSpecifiers;
let unresolved;
try {
  ({ files, bareSpecifiers, unresolved } = walkWorkerGraph({
    root: ROOT,
    entrypoints: ENTRYPOINTS,
    // Preserves the behaviour of the old walk(): record a file that won't ship,
    // but don't descend into it. Without this the walk would harvest the bare
    // specifiers of, say, the whole components/ subtree — and in this PR those
    // become prune roots, silently widening the tree exactly when the guard is
    // telling you something is wrong.
    shouldFollow: shipsInRuntimeImage,
  }));
} catch (err) {
  // The walk throws rather than exiting so it stays testable; rendering it as a
  // clean message is this script's job.
  console.error(`lint:worker-graph — ${err.message}`);
  process.exit(1);
}

const violations = [];
for (const [target, { importer, specifier }] of files) {
  if (!shipsInRuntimeImage(target)) violations.push({ target, importer, specifier });
}

if (unresolved.length > 0) {
  console.error(`lint:worker-graph — ${unresolved.length} specifier(s) could not be resolved:\n`);
  for (const { importer, specifier } of unresolved) {
    console.error(`  ${importer}  →  ${specifier}`);
  }
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const prodDeps = new Set(Object.keys(pkg.dependencies ?? {}));
const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

const misdeclared = [];
for (const [name, importer] of bareSpecifiers) {
  if (prodDeps.has(name)) continue;
  misdeclared.push({ name, importer, kind: devDeps.has(name) ? 'devDependency' : 'undeclared' });
}

if (misdeclared.length > 0) {
  console.error(
    `lint:worker-graph — ${misdeclared.length} package(s) the worker imports are not production dependencies:\n`,
  );
  for (const { name, importer, kind } of misdeclared) {
    console.error(`  ${importer}`);
    console.error(`    imports ${name}  (${kind})`);
  }
  console.error('\nThe runtime image ships only production dependencies, pruned further to the');
  console.error("worker's closure. A devDependency resolves on your machine and in every test,");
  console.error('then is absent at runtime — the container dies at boot or a job fails silently.');
  console.error('\nFix by either:');
  console.error('  - moving the package to `dependencies` if the worker genuinely needs it, or');
  console.error('  - removing the import from the worker-reachable graph.');
  process.exit(1);
}

if (violations.length === 0) {
  console.log(
    `lint:worker-graph — OK (${files.size} modules reachable from the worker, all present in the runtime image)`,
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
