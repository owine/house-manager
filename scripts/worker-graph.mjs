#!/usr/bin/env node
// The worker's transitive import graph, walked from its runtime entrypoints.
//
// Extracted so exactly two consumers share one definition of "what the worker
// reaches": lint-worker-runtime-graph.mjs (asserts every hop ships in the
// image) and prune-worker-tree.mjs (deletes everything else). If these derived
// their roots differently, the guard would be validating a different graph than
// the one being cut — worse than no guard, because it reads as protection.
//
// Limitations:
//  - Regex specifier extraction, not a real parser. A fully dynamic
//    `import(someVar)` is invisible; there are none today.
//  - Presence of the file only, not that every named export exists. tsc covers that.
//
// The stakes changed when this started feeding the prune. A specifier this
// regex misses is not merely unchecked — it is absent from bareSpecifiers,
// therefore absent from the prune roots, therefore DELETED from the runtime
// image. That is why SPECIFIER_RE below covers side-effect imports
// (`import 'pkg'`), which the original guard's pattern did not match: harmless
// when everything shipped, silently fatal once the tree is cut.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

// Core modules are not packages. Skipping only `node:`-prefixed specifiers is
// not enough: `import fs from 'fs'` is legal and would otherwise be collected
// as a bare specifier, which the guard reports as an undeclared dependency and
// the prune promotes to a ROOT — where computeClosure throws
// `root 'fs' is not installed` and aborts the build. Derived from Node rather
// than hand-listed so it cannot go stale.
const CORE_MODULES = new Set(builtinModules);

// Both entrypoints run under tsx against the SAME pruned node_modules.
// prisma/seed.ts is not optional: web boot runs it, so a package only it
// imports must survive the prune or the web container crash-loops.
export const ENTRYPOINTS = ['worker/index.ts', 'prisma/seed.ts'];

const EXTS = ['.ts', '.tsx', '.mjs', '.js', '.json'];
const INDEXES = EXTS.map((ext) => `index${ext}`);

// `import x from 'y'`, `export * from 'y'`, `import('y')`, `require('y')`,
// and `import 'y'` (side-effect) — the last is new; see the note above on why
// a missed specifier is now fatal rather than merely unchecked.
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Bare specifier → package name. `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveSpecifier(spec, fromFile, root) {
  let base;
  if (spec.startsWith('@/')) base = join(root, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // bare package

  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  for (const index of INDEXES) {
    const candidate = join(base, index);
    if (existsSync(candidate)) return candidate;
  }
  return { unresolved: base };
}

/**
 * Walk the transitive graph from the given entrypoints.
 *
 * @param {object}   opts
 * @param {string}   opts.root         repo root
 * @param {string[]} [opts.entrypoints]
 * @param {(relPath: string) => boolean} [opts.shouldFollow]
 *   Optional gate. When it returns false for a resolved file, that file is
 *   still RECORDED but not descended into. The guard passes
 *   `shipsInRuntimeImage` so a file that won't exist at runtime doesn't drag
 *   its own subtree into the graph — which in the prune would silently become
 *   extra roots at exactly the moment the guard is reporting a problem. The
 *   prune passes nothing: it runs against a tree where everything still exists.
 *
 * @returns {{
 *   files: Map<string, {importer: string, specifier: string}>,
 *   bareSpecifiers: Map<string, string>,
 *   unresolved: Array<{importer: string, specifier: string}>
 * }}
 *   files          — repo-relative path → who imported it and via what specifier
 *                    (entrypoints get empty strings for both)
 *   bareSpecifiers — package name → the repo-relative file that first imported it
 *   unresolved     — specifiers that resolved to nothing on disk
 */
export function walkWorkerGraph({ root, entrypoints = ENTRYPOINTS, shouldFollow }) {
  const files = new Map();
  const bareSpecifiers = new Map();
  const unresolved = [];
  const visited = new Set();

  function walk(file, importedBy, viaSpecifier) {
    if (visited.has(file)) return;
    visited.add(file);
    files.set(relative(root, file), { importer: importedBy, specifier: viaSpecifier });

    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const m of text.matchAll(SPECIFIER_RE)) {
      const spec = m[1];
      if (spec.startsWith('node:') || CORE_MODULES.has(packageNameOf(spec))) continue;

      const resolved = resolveSpecifier(spec, file, root);
      const importer = relative(root, file);

      if (resolved === null) {
        const pkg = packageNameOf(spec);
        if (!bareSpecifiers.has(pkg)) bareSpecifiers.set(pkg, importer);
        continue;
      }
      if (typeof resolved === 'object') {
        unresolved.push({ importer, specifier: spec });
        continue;
      }

      const targetRel = relative(root, resolved);
      if (shouldFollow && !shouldFollow(targetRel)) {
        // Record it so the caller can report it, but do not descend.
        if (!files.has(targetRel)) files.set(targetRel, { importer, specifier: spec });
        continue;
      }
      walk(resolved, importer, spec);
    }
  }

  for (const entry of entrypoints) {
    const path = join(root, entry);
    // Throw rather than exit: this module is imported by two scripts AND by
    // unit tests, and a library that kills the process cannot have this path
    // tested at all — vitest would die with it. Both consumers catch and
    // render the message in the guard's usual style.
    // No prefix on the message: each consumer adds its own, and two would read
    // as `lint:worker-graph — worker-graph — entrypoint …`.
    if (!existsSync(path)) throw new Error(`entrypoint ${entry} not found.`);
    walk(path, '', '');
  }

  return { files, bareSpecifiers, unresolved };
}
