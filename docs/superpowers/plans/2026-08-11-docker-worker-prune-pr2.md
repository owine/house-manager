# Worker Tree Prune (PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prune `/app/node_modules` from the full production tree (952 MB, 553 packages) down to the closure actually reachable from the worker and seed entrypoints (547 MB, 272 packages), saving ~405 MB.

**Architecture:** The transitive import walk currently embedded in `lint-worker-runtime-graph.mjs` is extracted into `scripts/worker-graph.mjs` and consumed twice — by the guard, and by a new build-time prune script that walks pnpm's `.pnpm` symlink closure from the *derived* roots and deletes everything unreachable. Deriving rather than hand-listing is what stops the two from disagreeing.

**Tech Stack:** Node ESM scripts (no deps), pnpm's `.pnpm` store layout, Vitest, Docker BuildKit.

**Spec:** `docs/superpowers/specs/2026-08-11-docker-image-size-design.md`

**Depends on:** PR1 (`docs/superpowers/plans/2026-08-11-docker-standalone-pr1.md`). This PR **cannot** land first — pruning removes `next`, and web runs `next start` until standalone replaces it.

---

## Background the implementer needs

**This is the PR that can silently break production.** Everything else in this design fails loudly. An over-aggressive prune produces a green build, a passing typecheck, a passing unit suite — and a container that dies at boot or, worse, boots fine and quietly stops running scheduled jobs. That exact failure (#333) took the worker down for five days with a healthy web container sitting next to it. Treat the sanity checks in Task 3 as the point of the work, not as decoration.

**Why the guard has a blind spot today.** `scripts/lint-worker-runtime-graph.mjs:78` returns `null` for bare package specifiers, commented *"bare package — lives in node_modules, which is copied"*. That comment stops being true in this PR.

**There are two runtime entrypoints, not one.** The guard walks `worker/index.ts`. But web boot also runs `node_modules/.bin/tsx prisma/seed.ts` out of the same pruned tree. Today `prisma/seed.ts` imports only `@prisma/adapter-pg`, `@prisma/client` and `../lib/reminders/system-user` — all inside the worker closure, so it is safe *by accident*. A future seed edit would crash-loop the **web** container.

**pnpm's layout, briefly.** Every package physically lives at `node_modules/.pnpm/<name>@<version>_<hash>/node_modules/<name>`. Top-level `node_modules/<name>` is a symlink into that store, and each store entry has its own nested `node_modules` of symlinks to its dependencies. Reachability means: follow top-level symlinks for the roots, then recurse through each entry's nested symlinks.

**Non-obvious required survivors.** `typescript` is a devDependency that survives only as a transitive of the `prisma` production package — and the Prisma CLI needs it at web boot because `prisma.config.ts` is TypeScript. Deleting it breaks `migrate deploy` with an error that points at config parsing, not at pruning.

**Repo conventions that apply:**
- `pnpm`, never `npx`/`npm`.
- Never `--no-verify`. `git commit` can fail *silently* behind the Biome pre-commit hook — **verify `HEAD` actually moved**.
- Do **not** use a git worktree here (knip hangs and blocks pre-push; missing `.env` breaks `prisma generate`).
- Colocated tests are in both the Vitest unit include and the coverage include. Never lower a coverage threshold to fix a red run.

## File structure

| File | Responsibility |
|---|---|
| `scripts/worker-graph.mjs` *(create)* | The transitive import walk. Pure, dependency-free, no I/O beyond reading source files. Single source of truth for "what the worker reaches". |
| `tests/unit/worker-graph.test.ts` *(create)* | Unit tests for the walk against fixture files. Lives here, not beside the script, because `test:unit` takes explicit directory args and vitest's `include` only matches `*.test.ts`. |
| `scripts/lint-worker-runtime-graph.mjs` *(modify)* | Keeps Dockerfile COPY parsing and local-file checks; imports the walk; adds the declared-dependency assertion. |
| `scripts/prune-worker-tree.mjs` *(create)* | Closure walk over `.pnpm` + deletion + sanity checks. |
| `tests/unit/prune-worker-tree.test.ts` *(create)* | Unit tests for the closure walk against a synthetic `.pnpm`-shaped fixture. |
| `Dockerfile` *(modify)* | One `RUN` after `pnpm prune --prod`. |
| `CLAUDE.md` *(modify)* | Documents that the worker tree is pruned and what that implies. |

---

## Task 1: Extract the import walk

Pure refactor. No behaviour change, so the existing guard output is the test.

**Files:**
- Create: `scripts/worker-graph.mjs`
- Modify: `scripts/lint-worker-runtime-graph.mjs`

- [ ] **Step 1: Record the current guard output**

```bash
pnpm lint:worker-graph
```
Expected: `lint:worker-graph — OK (72 modules reachable from the worker, all present in the runtime image)`

Write the number down. It must not change in this task.

- [ ] **Step 2: Create the module**

```javascript
#!/usr/bin/env node
// The worker's transitive import graph, walked from its runtime entrypoints.
//
// Extracted so exactly two consumers share one definition of "what the worker
// reaches": lint-worker-runtime-graph.mjs (asserts every hop ships in the
// image) and prune-worker-tree.mjs (deletes everything else). If these derived
// their roots differently, the guard would be validating a different graph than
// the one being cut — worse than no guard, because it reads as protection.
//
// Limitations (inherited, unchanged):
//  - Regex specifier extraction, not a real parser. A fully dynamic
//    `import(someVar)` is invisible; there are none today.
//  - Presence of the file only, not that every named export exists. tsc covers that.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Both entrypoints run under tsx against the SAME pruned node_modules.
// prisma/seed.ts is not optional: web boot runs it, so a package only it
// imports must survive the prune or the web container crash-loops.
export const ENTRYPOINTS = ['worker/index.ts', 'prisma/seed.ts'];

const EXTS = ['.ts', '.tsx', '.mjs', '.js', '.json'];
const INDEXES = EXTS.map((ext) => `index${ext}`);

// `import x from 'y'`, `export * from 'y'`, `import('y')`, `require('y')`
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

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
 * @returns {{files:Set<string>, bareSpecifiers:Map<string,string>, unresolved:Array}}
 *   files          — repo-relative paths reachable at runtime
 *   bareSpecifiers — package name → the repo-relative file that first imported it
 *   unresolved     — specifiers that resolved to nothing on disk
 */
export function walkWorkerGraph({ root, entrypoints = ENTRYPOINTS }) {
  const files = new Set();
  const bareSpecifiers = new Map();
  const unresolved = [];
  const visited = new Set();

  function walk(file) {
    if (visited.has(file)) return;
    visited.add(file);
    files.add(relative(root, file));

    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const m of text.matchAll(SPECIFIER_RE)) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;

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
      walk(resolved);
    }
  }

  for (const entry of entrypoints) {
    const path = join(root, entry);
    if (!existsSync(path)) throw new Error(`worker-graph: entrypoint ${entry} not found`);
    walk(path);
  }

  return { files, bareSpecifiers, unresolved };
}
```

- [ ] **Step 3: Rewrite the guard to consume it**

Precise edits, by current line number:

1. **Replace lines 32–44** (the `node:fs`/`node:path` imports, `ROOT`, `DOCKERFILE`, `ENTRYPOINTS`, `EXTS`, `INDEXES`, `SPECIFIER_RE`) with:

```javascript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRYPOINTS, walkWorkerGraph } from './worker-graph.mjs';

const ROOT = process.cwd();
const DOCKERFILE = join(ROOT, 'Dockerfile');
```

2. **Keep lines 46–71 unchanged** — `runtimePaths()`, `const RUNTIME_PATHS`, `shipsInRuntimeImage()`.

3. **Delete lines 73–134** — `resolveSpecifier()`, the `visited`/`violations`/`unresolved` declarations, `walk()`, and the entrypoint loop.

4. **Insert in their place:**

```javascript
const { files, bareSpecifiers, unresolved } = walkWorkerGraph({
  root: ROOT,
  entrypoints: ENTRYPOINTS,
});

const violations = [];
for (const [target, importer] of files) {
  if (!shipsInRuntimeImage(target)) violations.push({ target, importer });
}
```

5. **Keep the report blocks (lines 136–165) verbatim**, including wording and remediation advice. They already print `importer`, `specifier` and `target`.

**Two consequences to handle, not skip:**

**(a) `files` must carry its importer.** The reports print which file caused each violation, so a bare `Set` of paths loses information the existing wording depends on. Change `walkWorkerGraph`'s `files` from `Set<string>` to `Map<string, string>` (repo-relative path → repo-relative importer, empty string for entrypoints), and update `scripts/worker-graph.mjs` accordingly:

```javascript
const files = new Map();
// …in walk(), replace `files.add(relative(root, file))` with:
files.set(relative(root, file), importerRel);
```
threading an `importerRel` argument through `walk(file, importerRel = '')`.

**(b) Preserve the recursion stop.** The current `walk()` deliberately does **not** recurse into a file failing `shipsInRuntimeImage` (line 121-122: *"don't recurse into a file that won't exist at runtime"*). `walkWorkerGraph` has no such concept, so it would descend through e.g. the whole `components/` subtree on a violation and harvest its bare specifiers — which in this PR become **prune roots**. That silently widens the tree exactly when the guard is telling you something is wrong.

Give the walk an optional predicate and pass the guard's:

```javascript
// scripts/worker-graph.mjs — in walkWorkerGraph({ root, entrypoints, shouldFollow })
if (shouldFollow && !shouldFollow(relative(root, resolved))) {
  files.set(relative(root, resolved), importer);
  continue; // record the violation, do not descend
}
walk(resolved, importer);
```

The guard passes `shouldFollow: shipsInRuntimeImage`. The prune script passes nothing, so it walks the full graph — correct, because it runs against a tree where everything still exists.

- [ ] **Step 4: Verify the count changed only because of the new entrypoint**

```bash
pnpm lint:worker-graph
```
Expected: `OK (73 modules reachable …)` — exactly 73, up from 72. Adding `prisma/seed.ts` contributes itself; `lib/reminders/system-user.ts` was already reachable from the worker.

A count other than 73 means the walk changed behaviour, not just its location. Investigate before continuing.

If it reports violations, they are real: something reachable from `prisma/seed.ts` is not copied into the runtime image. Fix by moving the code under `lib/`, not by narrowing the entrypoints.

- [ ] **Step 5: Add unit tests**

**Location matters.** Put them at `tests/unit/worker-graph.test.ts`, not next to the script:

- `vitest.config.ts`'s `include` only matches `*.test.ts` / `*.test.tsx`, so a `.mjs` test file matches nothing and vitest reports "No test files found" rather than failing.
- `test:unit` is `vitest run tests/unit lib worker/jobs components app` — explicit directory arguments. Adding a glob to `include` would **not** make a `scripts/` test run under `pnpm verify` or in CI's `unit` job.

`tests/unit/**/*.test.ts` is already in both, so this needs **no config change**. Do **not** add `scripts/**` to `coverage.include` — it would add a large, thinly-covered denominator and redden the floor for no benefit.

Import the ESM script directly; add `// @ts-expect-error — untyped .mjs` if TS objects:

```typescript
const { walkWorkerGraph, packageNameOf } = await import('../../scripts/worker-graph.mjs');
```

Cover: relative resolution, `@/` alias resolution, bare-specifier collection with the importer recorded, scoped-package name extraction (`@scope/pkg/sub` → `@scope/pkg`), `node:` builtins excluded, comment stripping, and `shouldFollow` halting recursion while still recording the file. Build fixtures in a temp dir; never walk the real repo.

- [ ] **Step 6: Run the tests**

```bash
pnpm exec vitest run tests/unit/worker-graph.test.ts
```
Expected: PASS.

If it says "No test files found", the file is misnamed or misplaced — re-read Step 5.

- [ ] **Step 7: Commit**

```bash
git add scripts/worker-graph.mjs tests/unit/worker-graph.test.ts scripts/lint-worker-runtime-graph.mjs
git commit -m "refactor(scripts): extract the worker import graph walk

Two consumers need one definition of what the worker reaches: the
existing guard, and the tree prune that follows. Deriving roots two
different ways would mean the guard validates a different graph than the
one being cut.

Adds prisma/seed.ts as a second entrypoint. Web boot runs it against the
same node_modules, so a package only it imports must survive the prune —
today it is safe only by accident."
git rev-parse --short HEAD
```

---

## Task 2: Close the guard's bare-specifier blind spot

**Files:**
- Modify: `scripts/lint-worker-runtime-graph.mjs`

The obvious assertion — "is this package in the pruned tree?" — is circular: at lint time `node_modules` is the *full* tree, and roots derived from specifiers trivially contain all specifiers. The non-circular check is **declaration**: every bare specifier the worker reaches must be in `dependencies`, not `devDependencies` and not undeclared.

That catches a real class. Something in `lib/` importing `pino-pretty` (a devDependency) resolves on a dev machine and in every test, then vanishes from the production tree.

- [ ] **Step 1: Add the assertion**

```javascript
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
```

Place it after the `unresolved` check and before the violations report.

- [ ] **Step 2: Verify it passes on a clean tree**

```bash
pnpm lint:worker-graph
```
Expected: OK. All 17 roots are declared `dependencies` today, with no exception list needed beyond `node:` builtins (already handled in the walk).

- [ ] **Step 3: Prove it actually fires**

Temporarily add to `worker/index.ts`:

```typescript
import 'pino-pretty';
```

```bash
pnpm lint:worker-graph
```
Expected: **FAIL**, naming `worker/index.ts`, `pino-pretty`, and `(devDependency)`.

Then remove the import and confirm it returns to OK. **Do not commit the temporary import.**

- [ ] **Step 4: Commit**

```bash
git add scripts/lint-worker-runtime-graph.mjs
git commit -m "feat(scripts): assert worker imports are production dependencies

Line 78 returned null for bare specifiers, commented 'lives in
node_modules, which is copied'. That is about to stop being true.

Checks declaration rather than presence — presence is unanswerable at
lint time, where node_modules is the full tree. Catches a lib/ file
importing a devDependency, which resolves locally and in every test and
then is absent at runtime."
git rev-parse --short HEAD
```

---

## Task 3: The prune script

**Files:**
- Create: `scripts/prune-worker-tree.mjs`, `tests/unit/prune-worker-tree.test.ts`

- [ ] **Step 1: Write the failing test first**

Same location rule as Task 1 Step 5 — `tests/unit/prune-worker-tree.test.ts`, so it runs under `pnpm verify` and CI without config changes.

Build a synthetic `.pnpm`-shaped fixture in a temp dir:

```
node_modules/
  a -> .pnpm/a@1.0.0/node_modules/a
  .pnpm/
    a@1.0.0/node_modules/a/          (+ nested node_modules/b -> ../../b@1.0.0/node_modules/b)
    b@1.0.0/node_modules/b/
    orphan@1.0.0/node_modules/orphan/
```

**The nested symlink is `../../`, two levels, not three.** From
`.pnpm/a@1.0.0/node_modules/` two `..` lands at `.pnpm/`, which is where sibling
store entries live. This matches real pnpm — verify against this repo:

```bash
readlink node_modules/.pnpm/pg-boss@*/node_modules/pg
```
Expected: `../../pg@8.22.0/node_modules/pg`.

Three `..` would land at `node_modules/`, producing a dangling link that
`realpathSync` throws on and the `/* dangling */` catch swallows — so `b@1.0.0`
would never be reached and you would debug `computeClosure`, which is correct,
instead of the fixture.

Assert `computeClosure({ nodeModules, roots: ['a'] })` returns `{'a@1.0.0','b@1.0.0'}` and excludes `orphan@1.0.0`. Cover: transitive reach through nested symlinks, scoped packages (`@scope/pkg` → store entry `@scope+pkg@1.0.0`), a root that does not exist (must throw, not silently skip), and cycles (a → b → a must terminate).

```bash
pnpm exec vitest run tests/unit/prune-worker-tree.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

```javascript
#!/usr/bin/env node
// Prunes node_modules to the closure reachable from the worker's runtime
// entrypoints. Runs in the Docker build stage after `pnpm prune --prod`.
//
// Everything else in this design fails loudly. This is the one step that can
// produce a green build and a dead container, so it carries its own sanity
// checks — see SENTINELS and MIN_SURVIVOR_RATIO below.

import { readdirSync, realpathSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { walkWorkerGraph } from './worker-graph.mjs';

// Needed at boot but imported by nothing: web runs `prisma migrate deploy`
// and `tsx prisma/seed.ts`, neither of which appears in any import graph.
const BOOT_TOOLS = ['tsx', 'prisma'];

// Asserted present AFTER pruning, by stat-ing the resulting tree — not by
// testing membership of the computed root set, which would be vacuous for tsx
// and prisma (they are hardcoded roots above).
const SENTINELS = [
  'tsx', 'prisma',
  '@prisma/client', '@prisma/adapter-pg',
  'pg-boss', 'sharp', 'react-dom',
];

// typescript needs a DIFFERENT check and cannot go in the list above.
//
// The Prisma CLI reads prisma.config.ts at web boot, so it needs a TS loader at
// runtime. But typescript is a devDependency: `pnpm prune --prod` has already
// removed its top-level node_modules/typescript symlink before this script
// runs. It survives only as a nested transitive inside the `prisma` store
// entry, so a top-level existsSync would fail on every single build.
const STORE_SENTINEL_PREFIXES = ['typescript@'];

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
    try { entries = readdirSync(nested, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      const p = join(nested, e.name);
      if (e.name.startsWith('@')) {
        let scoped;
        try { scoped = readdirSync(p, { withFileTypes: true }); } catch { continue; }
        for (const s of scoped) {
          try { stack.push(realpathSync(join(p, s.name))); } catch { /* dangling */ }
        }
      } else {
        try { stack.push(realpathSync(p)); } catch { /* dangling */ }
      }
    }
  }
  return keep;
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += statSync(p).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return total;
}

function main() {
  const root = process.cwd();
  const nodeModules = join(root, 'node_modules');
  const store = join(nodeModules, '.pnpm');

  const { bareSpecifiers } = walkWorkerGraph({ root });
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

  // Store-level sentinels have no top-level symlink to stat (see the comment on
  // STORE_SENTINEL_PREFIXES), so check the surviving .pnpm entries instead.
  const survivors = readdirSync(store);
  for (const prefix of STORE_SENTINEL_PREFIXES) {
    if (!survivors.some((d) => d.startsWith(prefix))) missing.push(`${prefix}* (in .pnpm)`);
  }

  if (missing.length > 0) {
    console.error(`prune-worker-tree: FAILED — sentinels missing after prune: ${missing.join(', ')}`);
    console.error('These are required at runtime. The closure walk is wrong; do not ship this image.');
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
```

- [ ] **Step 3: Run the tests**

```bash
pnpm exec vitest run tests/unit/prune-worker-tree.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/prune-worker-tree.mjs tests/unit/prune-worker-tree.test.ts
git commit -m "feat(scripts): prune node_modules to the worker's closure

Walks pnpm's .pnpm symlink graph from roots derived from the real import
graph plus the two boot tools nothing imports, and deletes the rest.

Carries its own sanity checks because this is the one step in the design
that can produce a green build and a dead container: named sentinels
stat-ed against the post-prune tree, plus a deliberately slack 25%
survivor floor for the catastrophic case."
git rev-parse --short HEAD
```

---

## Task 4: Wire it into the build

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add the RUN**

Directly after `RUN pnpm prune --prod` in the build stage:

```dockerfile
# Reduce the production tree to what the worker's entrypoints actually reach.
# Web does not use this tree — it runs from /app/web, its own standalone
# bundle — so `next`, the UI libraries and the build toolchain can all go.
# Roots are DERIVED from the import graph (scripts/worker-graph.mjs), the same
# source the lint:worker-graph guard checks against, so the two cannot disagree.
RUN node scripts/prune-worker-tree.mjs
```

- [ ] **Step 2: Build and read the reported saving**

```bash
docker build -t house-manager:smoke . 2>&1 | grep "prune-worker-tree"
```
Expected: something close to `553 → 272 packages, 952MB → 547MB (dropped 281, freed 405MB)`.

If it **ABORTED** on the floor, the import walk regressed — debug `pnpm lint:worker-graph` first. If sentinels are missing, the closure walk is wrong. In neither case loosen the threshold.

- [ ] **Step 3: Smoke test — the real gate**

```bash
./scripts/smoke-image.sh house-manager:smoke
```
Expected: `SMOKE PASS` with all five ✓ lines.

The `✓ rendered 404 page` line matters most here. PR1 could pass it while leaning on the sibling tree via upward module resolution; this is the first build where that crutch is gone, so this is the moment a gap in the standalone bundle surfaces.

- [ ] **Step 4: Measure**

```bash
docker images house-manager:smoke --format '{{.Size}}'
```
Expected: ~0.9 GB, down from 2.22 GB.

- [ ] **Step 5: Verify the two trees independently**

```bash
docker run --rm --entrypoint sh house-manager:smoke -c '
  echo "worker tree:"; ls /app/node_modules | wc -l
  echo "next present in worker tree (expect absent):"; ls /app/node_modules/next 2>&1 | head -1
  echo "web tree:"; ls /app/web/node_modules | wc -l
  echo "sentinels:"; for p in tsx prisma typescript @prisma/client pg-boss sharp react-dom; do
    [ -e "/app/node_modules/$p" ] && echo "  ok $p" || echo "  MISSING $p"; done'
```
Expected: `next` absent from the worker tree; every sentinel `ok`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): prune node_modules to the worker closure

952MB -> 547MB, 553 -> 272 packages. Web runs from its own standalone
bundle at /app/web, so next, the UI libraries and the build toolchain
are dead weight in this tree.

Image: 2.22GB -> ~0.9GB."
git rev-parse --short HEAD
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend the two-tree paragraph added in PR1**

```markdown
`/app/node_modules` is **pruned at build time** to the closure reachable from
`worker/index.ts` and `prisma/seed.ts` (`scripts/prune-worker-tree.mjs`), so it
holds ~272 of the ~553 production packages. Roots are derived from the same
import walk `lint:worker-graph` uses (`scripts/worker-graph.mjs`) — a hand-kept
list would drift from the graph and the guard would then be checking something
other than what gets cut.

**Adding a worker dependency means it must be a production dependency.** The
guard now rejects a devDependency reached from the worker graph, because such an
import resolves on your machine and in every test and is simply absent at
runtime. `prisma/seed.ts` counts as worker-reachable: web boot runs it against
this same tree.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the worker tree is pruned, and what that implies"
git rev-parse --short HEAD
```

---

## Task 6: Full verification before pushing

- [ ] **Step 1**

```bash
pnpm verify
```
Expected: pass, including the extended `lint:worker-graph`.

- [ ] **Step 2**

```bash
pnpm test:local
```
Expected: pass. Do not lower a coverage threshold to get here.

- [ ] **Step 3: Clean-build smoke**

```bash
docker build --no-cache -t house-manager:smoke . && ./scripts/smoke-image.sh house-manager:smoke
```
Expected: `SMOKE PASS`. `--no-cache` matters — a cached `node_modules` layer can mask a prune that only works incrementally.

- [ ] **Step 4: Push and open the PR**

Include measured before/after image size and the `prune-worker-tree` output line.

---

## Done when

- [ ] `pnpm lint:worker-graph` covers both entrypoints and rejects devDependency imports
- [ ] `scripts/prune-worker-tree.mjs` has unit tests covering transitive reach, scoped packages, cycles, and a missing root
- [ ] A `--no-cache` build passes `scripts/smoke-image.sh`
- [ ] `next` is absent from `/app/node_modules`; every sentinel present
- [ ] Image is ~0.9 GB
- [ ] `pnpm test:local` passes
