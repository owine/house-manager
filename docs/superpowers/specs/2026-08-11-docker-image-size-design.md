# Docker image size — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented

## Motivation

The published image is **2.22 GB** uncompressed (~400 MB compressed). It is
built for two platforms (`linux/amd64`, `linux/arm64`) on every push to `main`,
cached with `cache-to: type=gha,mode=max`, and pulled to the production host on
every deploy.

That size is not one problem, it is four, and they were all confirmed as real:
slow deploys/pulls, CI cache pressure (GitHub caps Actions cache at 10 GB per
repo — `mode=max` on a 2.2 GB image across two platforms plausibly exceeds it
and thrashes), disk on the production host, and plain indefensibility for an app
of this size.

### Where the weight actually is

Measured on a real build, not estimated:

| Layer | Size |
|---|---|
| `node_modules` (production, post-prune) | **1.14 GB** |
| `node:24-alpine` base | 161 MB |
| `.next` | 84 MB |
| `apk add curl pg18-client vips vips-heif` | 68 MB |
| corepack + pnpm in runtime | 40 MB |
| app source (`lib/`, `worker/`, `prisma/`, `public/`) | ~2 MB |

The first hypothesis — that `pnpm prune --prod` was stranding orphaned packages
in `node_modules/.pnpm`, the classic pnpm-in-Docker trap — was **tested and
disproved**. Walking the symlink graph inside the image gives 555 reachable /
555 total, 0 orphaned. The prune is clean; that 1.14 GB is genuinely-reachable
production dependencies.

Itemised:

| Subtree | Size | Needed at runtime? |
|---|---|---|
| `next` + `@next/swc-*-musl` | 288 MB | swc is the **compiler** — build-only |
| Prisma CLI chain (`@prisma/studio-core`, `effect`, `pglite`, `typescript`, `@prisma/engines`) | ~185 MB | only for `prisma migrate deploy` at boot |
| `@prisma/client` | 86 MB | yes |
| OCR/imaging (`tesseract.js-core`, `pdfjs-dist`, `@napi-rs/canvas`, sharp libvips ×2) | ~135 MB | yes — real worker deps |
| `lucide-react` | 35 MB | **no** — bundled into `.next` at build |
| `@sentry/cli` (via `@sentry/nextjs`) | 18 MB | **no** — source-map upload only |

The root cause is structural: the Dockerfile does
`COPY --from=build /app/node_modules ./node_modules`, shipping every production
dependency whether or not any code path reaches it. Next.js already computes the
real answer at build time (63 `*.nft.json` trace files) and we throw it away.

## Constraints discovered

1. **One image, two roles.** `web` runs `next start`, `worker` runs
   `tsx worker/index.ts`. A single `HEALTHCHECK` covers both because each
   container has its own network namespace, so both can bind 3000. Preserving
   this was an explicit requirement — see *Alternatives rejected*.

2. **The worker is invisible to Next's tracing.** Standalone traces the Next
   app. The worker runs TypeScript through `tsx` with no compile step, against
   `lib/`. Diffing the 45 production dependencies against the traced set: 9 are
   traced, and of the 36 that are not, roughly half are bundled into `.next` at
   build (`lucide-react`, `react-hook-form`, `@base-ui/react`, …) while the rest
   are genuinely worker-only (`pg-boss`, `tsx`, `tesseract.js`, `web-push`,
   `ical-generator`, `meilisearch`, `unpdf`, `rrule`, `@sentry/node`, …).

3. **`lint:worker-graph` has a load-bearing blind spot.** Line 78 returns `null`
   for bare package specifiers, commented *"lives in node_modules, which is
   copied."* Pruning `node_modules` makes that comment false and blinds the
   guard to exactly the failure mode this change introduces. This is the same
   guard that exists because of #333 (five-day silent worker outage).

4. **Not a monorepo.** `pnpm-workspace.yaml` carries settings only, no
   `packages:` field, so `pnpm deploy --filter` is unavailable.

5. **`preferFrozenLockfile: true`.** Any approach introducing a second manifest
   must also introduce a second lockfile, or abandon exact pinning.

6. **Production compose lives in a separate GitOps repo**, not here. The
   in-repo `docker-compose.yml` targets `house-manager:dev` and is
   dev-only. Changing how web starts requires a coordinated edit there.

7. **Prisma needs no engine binary.** `@prisma/client` ships no `.node` files
   and no engine binaries — pure JS `runtime/` — and `lib/db.ts` uses the
   `PrismaPg` driver adapter. The historical standalone-plus-Prisma failure
   (a Rust query engine resolved by path, invisible to tracing) does not apply.
   The schema engine that remains is used by `prisma migrate` at boot, not by
   the app.

8. **`react`/`react-dom` are genuine worker dependencies.** `lib/email/render.ts`
   calls `renderToStaticMarkup` from `react-dom/server`; the digest and reminder
   templates are React. Not an artifact of the graph walk.

## Measurements

Everything below was measured inside a real build, on the current lockfile.

**What Next actually traces** (parsed from the 63 `*.nft.json` files, summing
individual traced *files* — not their parent packages):

```
unique traced files:        1,806
TOTAL traced bytes:          47.8 MB
  of which node_modules:     37.0 MB  (1,357 files)
```

`next` collapses from 198 MB to 11.6 MB; `@prisma/client` from 86 MB to 5.1 MB.
Measuring at package granularity instead gives ~667 MB — an 18× overestimate,
and the reason a package-level estimate must not be used here.

**Worker dependency closure** (walking `.pnpm` symlinks from the 17 roots the
import graph reaches):

```
full prod tree (today)        553 pkgs = 952 MB
worker closure (17 roots)     269 pkgs = 527 MB
  + tsx & prisma CLI (boot)   272 pkgs = 547 MB
DROPPED                       281 pkgs = 405 MB
```

Note the Prisma CLI adds only **20 MB** on top of the worker closure, not the
185 MB the subtree table suggests — most of it is shared with `@prisma/client`,
which the worker needs anyway. A separate one-shot migrate container was
considered and dropped for this reason.

**Projected result: 2.22 GB → ~0.9 GB.**

## Decisions

| Question | Decision |
|---|---|
| Image count | **One image**, both roles — unchanged |
| Web runtime | Next `output: 'standalone'`, run as `node web/server.js` |
| Worker tree | `pnpm prune --prod`, then closure-prune to the worker's derived roots |
| Layout | Standalone at `/app/web/` (own flat `node_modules`); worker tree stays at `/app/node_modules` |
| Root derivation | **Derived** from the real import graph, never hand-listed |
| Prod compatibility | Change the image `CMD`; edit the GitOps compose in the same window |
| pnpm in runtime | **Removed** — `prisma`/`tsx` invoked via `node_modules/.bin/` |
| Migrations | Stay at web boot (moving them saves only 20 MB) |
| Verification | Static guard **and** CI runtime smoke test |
| Sequencing | Two PRs; smoke test lands in PR1 |

### Why two directories rather than one merged tree

Next's standalone output is a **flat, self-contained** `node_modules`; pnpm's is
a symlinked `.pnpm` store. Both want `/app/node_modules`. Merging two different
layouts is fiddly and fails subtly. Keeping them separate costs ~37 MB of
overlap — the entire price of staying on one image.

### Why closure-pruning rather than a second install

Two alternatives were considered and rejected:

- **Second manifest + separate `pnpm install`** — fights `preferFrozenLockfile`.
  Either commit a second lockfile (two to keep in sync, exactly the drift
  documented in `feedback_worker_action_duplicate_paths.md`) or install
  unpinned, abandoning the exact-pinning convention.
- **Trace the worker with `@vercel/nft`** — symmetric with standalone and
  file-precise, but nft traces JS while the worker is TS run through `tsx`. It
  would need a compile step purely to trace, contradicting the deliberate
  no-compile-step decision, and its failure mode is silent under-inclusion.

Closure-pruning is the only option that keeps a **single source of truth** for
"what the worker needs" — which is what makes the extended guard trustworthy.

## Architecture

### Runtime image layout

```
/app
├── web/                    ← .next/standalone, self-contained
│   ├── server.js
│   ├── node_modules/       ← Next-traced, ~37 MB
│   ├── .next/  (+ static/) ← static copied in separately
│   └── public/             ← copied in separately
├── node_modules/           ← pruned pnpm tree (~547 MB)
├── lib/  worker/  prisma/
└── auth.config.ts  tsconfig.json  package.json  prisma.config.ts
```

### Build flow

```
build:  COPY node_modules (from deps)     ← cached on lockfile
        COPY . .
        prisma generate
        next build                        ← now also emits .next/standalone
    NEW cp public → .next/standalone/
        cp .next/static → .next/standalone/.next/
        pnpm prune --prod
    NEW node scripts/prune-worker-tree.mjs

runtime: COPY /app/node_modules   → ./node_modules   (largest, most stable, first)
         COPY /app/.next/standalone → ./web
         COPY lib/ worker/ prisma/ + manifests
```

`node_modules` content becomes a function of *(lockfile + worker import graph)*
rather than *(lockfile)* alone, so it re-materialises when the worker's
dependency set changes. That is rare, the build stage already sits downstream of
`COPY . .`, and the layer being 405 MB smaller reduces cache pressure far more
than the added sensitivity costs.

### New runtime environment

`HOSTNAME=0.0.0.0` and `PORT=3000`. Standalone's `server.js` binds localhost by
default, which would leave the `HEALTHCHECK` curl hitting a port nothing is
listening on from outside the container.

### Boot commands

- web: `prisma migrate deploy && tsx prisma/seed.ts && node web/server.js`
- worker: `node_modules/.bin/tsx worker/index.ts` (unchanged in substance)

## Components

### `scripts/worker-graph.mjs` — new, extracted

The transitive walk currently inside `lint-worker-runtime-graph.mjs`, lifted so
two consumers share one definition of what the worker reaches.

```
walkWorkerGraph({ root }) → { files:Set, bareSpecifiers:Set, unresolved:Array }
```

Depends only on `node:fs`/`node:path`. Single source of truth, in the spirit of
`lib/queue.ts`'s `Queue` const.

### `scripts/lint-worker-runtime-graph.mjs` — modified

Keeps Dockerfile `COPY` parsing and local-file checks; imports the walk rather
than owning it.

**New assertion: every bare specifier the worker reaches must be a declared
`dependency`** — not a `devDependency`, not undeclared.

The obvious assertion ("is it in the pruned tree?") is circular: at lint time
`node_modules` is the full tree, and roots derived from specifiers trivially
contain all specifiers. The declared-dependency check is not circular and
catches a real class — something in `lib/` importing a devDependency (say
`pino-pretty`) resolves on a dev machine and in every test, then vanishes from
the production tree. Invisible today.

### `scripts/prune-worker-tree.mjs` — new

Runs in the `build` stage after `pnpm prune --prod`. Takes derived roots plus
`['tsx', 'prisma']` for boot, walks the `.pnpm` symlink closure, deletes
unreachable package directories and dangling top-level symlinks. Logs
before/after counts and bytes.

**Sanity floor.** If the graph walk ever regresses and returns few or no roots,
a naive prune would delete nearly everything and produce a broken image that
still *builds successfully*. The script refuses to run when the closure falls
below a plausible threshold, failing the build loudly. Every other failure in
this design is loud; this is the one that would be silent.

### `scripts/smoke-image.sh` — new

Boots both roles from the actually-built image against a Postgres service and
asserts:

- web `/api/health` → 200
- worker `/api/health` → 200
- **a known static asset resolves** — `/api/health` returns 200 even with
  `public/` or `.next/static` missing, so health alone would pass while the app
  serves no CSS

Runs inside the existing `build-image` job, which needs `load: true`. Safe
because the matrix is one platform per native runner, so there is no multi-arch
load conflict. `/api/health` needs Postgres (fatal) but not Meilisearch
(non-fatal; `/api/health/ready` is the stricter contract).

## Failure modes

| Failure | Defense |
|---|---|
| Prune removes a package the worker needs | Roots derived from the real graph, never hand-listed; guard's declared-dependency check; smoke test boots the worker |
| Graph walk regresses → over-prune, green build, dead container | Sanity floor in the prune script |
| `lib/` imports a devDependency | New guard assertion (invisible today) |
| Standalone misses a traced file | Smoke test + existing e2e |
| `HOSTNAME` unset → binds localhost | Smoke test fails immediately |
| `public/` or `.next/static` not copied | Smoke test's static-asset fetch |
| GitOps compose not updated | Compose change lands in PR1, before anything depends on it |

**Known limitation.** A dependency doing a *dynamic* `require` of a package it
does not declare is invisible to static analysis; only the smoke test would
catch it. pnpm's strict non-hoisted layout makes this fail in development too,
which is real mitigation but not a guarantee.

## Testing

- `pnpm verify` unchanged; `lint:worker-graph` gains the new assertion and keeps
  running pre-push and in CI's lint job
- **Unit test for the closure walk** against a synthetic `.pnpm`-shaped fixture.
  This script can delete most of the image; its logic needs direct coverage, not
  only end-to-end confidence
- **CI smoke test** as described above
- `pnpm test:local` before merge, per CLAUDE.md
- Visual-regression suite unaffected — it runs against a dev server, not the image

## Sequencing

**PR1 — standalone.** `output: 'standalone'`, `/app/web` layout, `HOSTNAME`/
`PORT`, `CMD` change, in-repo compose edit, GitOps compose edit, docs, smoke
test. Image grows ~50 MB. Low risk, fully verifiable.

**PR2 — prune.** Extract `worker-graph.mjs`, extend the guard, add the prune
script + sanity floor + unit test. The 405 MB win, landing on a safety net
already proven green by PR1.

The prune **cannot** precede standalone: pruning removes `next`, and web runs
`next start` until standalone replaces it.

## Already landed separately

Dropping the unused `vips` / `vips-heif` apk packages — **77 MB measured**
(2.30 GB → 2.22 GB). sharp does not use system libvips: it ships a prebuilt
`@img/sharp-libvips-linuxmusl-*` and its native binary resolves
`libvips-cpp.so` to that bundled copy, never `/usr/lib/libvips.so.42`. The
bundled build already carries HEIF, verified by `sharp.versions` reporting vips
8.18.3 + heif 1.23.1 while the apk packages were 8.18.2. The packages are 2.7 MB
themselves but drag in glib/cairo/pango/libheif transitively.

## Out of scope

- **Splitting into two images.** Explicitly rejected: it would trade away the
  single `HEALTHCHECK` and one-image deployment. Worth noting this design makes
  the split *nearly free* later — the trees become cleanly separated, so it
  reduces to two `runtime` targets each copying one tree (est. web ~290 MB,
  worker ~720 MB). Deferred, not foreclosed.
- **A single mono-container running both roles.** Considered and rejected: it
  saves zero bytes (Docker stores layers once per host regardless of container
  count), *adds* weight via a supervisor, breaks the port-3000 arrangement that
  relies on separate network namespaces, and loses crash isolation and per-role
  health signal.
- **A separate one-shot migrate container.** Saves only 20 MB measured.
- **Deduplicating the two `@img/sharp-libvips` copies** (~33 MB) — separate,
  driven by Next's transitive `^0.34.5` pin.
- **HEIC input support.** `sharp.format.heif.input.fileSuffix` lists only
  `.avif` despite HEIF being compiled in. A correctness question, not a size
  one, and untouched here.
