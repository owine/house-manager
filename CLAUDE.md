# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

House Manager — a self-hosted home information manager. Next.js 16 (App Router, RSC)
+ Prisma 7 / Postgres 18 + pgvector, Meilisearch, and a pg-boss worker.

Full docs live in [`docs/README.md`](docs/README.md) (stack, env vars, production),
[`docs/TESTING.md`](docs/TESTING.md), [`docs/observability.md`](docs/observability.md),
and [`docs/backups.md`](docs/backups.md). This file covers only what isn't visible from
the code itself.

## Commands

```bash
pnpm dev                  # web dev server
pnpm worker:dev           # worker (separate terminal; tsx, no build step)
docker compose up -d db meilisearch   # prerequisite infra for dev/test

pnpm verify               # lint + typecheck + test:unit — run before pushing
pnpm lint                 # biome check . && lint:tokens && lint:knip
pnpm lint:fix             # biome autofix
pnpm typecheck            # tsc --noEmit (TS 7)

pnpm test:unit            # tests/unit + lib + worker/jobs + components (mocked)
pnpm test:integration     # tests/integration — real Postgres via Testcontainers
pnpm test:e2e:local       # full Playwright suite w/ env wrapper + mock OIDC
pnpm test:local           # umbrella pre-merge: unit → integration → e2e → coverage floor

pnpm db:migrate           # prisma migrate dev
pnpm db:seed
```

Use `pnpm` — never `npx`/`npm`. They emit pnpm-config warnings and bypass resolution.

**Running a single test:**

```bash
pnpm exec vitest run lib/reminders/recurrence.test.ts     # one file
pnpm exec vitest run lib/reminders -t "monthly weekday"   # by test name
pnpm test:e2e:local tests/e2e/signin.spec.ts              # one Playwright spec
```

Note `pnpm test:unit` and `pnpm test:integration` both pass directory args, so
appending a path *widens* the run rather than narrowing it — invoke `vitest`
directly for a single file:

```bash
pnpm exec vitest run tests/integration/notify-job.test.ts   # one integration file
```

**CI vs local.** CI runs a lean gate: lint, typecheck, migrate-check, ggshield, unit,
integration, and only `@critical` e2e. The **full** e2e suite and the coverage floor are
your responsibility via `pnpm test:local`. Coverage is enforced once, in a dedicated
`coverage` job that merges the unit + integration blobs — neither subset clears the floor
alone, so never "fix" a red coverage job by lowering a threshold in `vitest.config.ts`.
The floor only ratchets up.

## Architecture

**Feature-module convention.** Every domain follows the same triple under `lib/<feature>/`:

| File | Contains |
|---|---|
| `schema.ts` | Zod only. `create<X>Schema`, `update<X>Schema = create.partial().extend({ id })`, `Create<X>Input` type. Colocated `schema.test.ts`. |
| `queries.ts` | Read-only Prisma. **No `'use server'`, no `auth()`.** Takes `ListParams` from `@/lib/url-params`, returns `{ <plural>, total }`. |
| `actions.ts` | `'use server'` mutations. |

There is no `types.ts` and no barrel `index.ts`. Server components import `queries.ts`
directly — there is no fetch-to-own-API layer.

**`.partial()` does not strip `.default()`.** `updateItemSchema.safeParse({ id, name })`
returns `metadata: {}`; `updateVendorSchema.safeParse({ id, name })` returns `tags: []`.
Defaults are resurrected on fields the caller never mentioned, so a *partial* patch
overwrites them — and a guard like `if (metadata !== undefined)` does not save you,
because an injected `{}` is defined.

Nothing sends a partial patch today (the forms send every field, and the chat apply
path writes via `prisma.item.update` directly), so this is a live trap rather than a
live bug. If you write a narrow action, build the update schema from a defaults-free
core instead — `lib/parts/schema.ts` does exactly that and explains why.

**`z.string().url()` is not a safety check.** It accepts `javascript:`, `data:` and
`ftp:` — it validates URL syntax, not scheme. Any user-supplied URL rendered into an
`href` must use `httpUrlSchema` from `lib/http-url.ts`.

**Server-action skeleton** (`lib/items/actions.ts` is canonical). Deviating from this
shape is a review finding:

```ts
'use server';
export async function createItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user) return { ok: false, formError: 'Unauthorized' };   // never throw

  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const item = await prisma.item.create({ data: ... });
  await enqueueSearchIndex('item', item.id, 'upsert');   // side effects: never fatal
  await enqueueEmbed('ITEM', item.id);

  revalidatePath('/items');
  revalidatePath('/dashboard');
  return { ok: true, data: { id: item.id } };
}
```

The parameter is always `input: unknown` — never `FormData`. `ActionResult` is the
three-line union in `lib/result.ts`; extend it with a bespoke union only when a caller
must branch on a structured payload rather than a message (see `lib/vendors/actions.ts`
`TryDeleteVendorResult`).

**Forms.** `'use client'` + react-hook-form + `zodResolver` on the shared server schema,
`useTransition` for pending state. `useActionState` is used nowhere. The action is
**injected as a prop** by the server page, not imported by the client component — one
component serves create and edit, distinguished by `defaultValues?.id`. Server field
errors are merged back into RHF via `applyActionFieldErrors` (`lib/forms/helpers.ts`);
form-level errors go to `root`; toasts via `sonner`. Type form values as
`z.input<typeof schema>`, not `z.infer`, so `.default()`/`.coerce` fields line up.

**Worker.** `lib/queue.ts` holds the `Queue` const object — the single source of truth
for all 13 queue names, and pg-boss 10+ requires `createQueue` before any `send`/`work`.
All `boss.work(...)` registration lives in one `main()` in `worker/index.ts`; there is
no auto-discovery. **Adding a job means three edits**: a `Queue` entry, a job module
under `worker/jobs/`, and an import + `boss.work` block in `worker/index.ts`.

Ticks: `reminders.tick` and `notify-log.sweep` every 5 min, `digest.tick` every 30 min,
`chore-auto-complete.tick` hourly, `search.reindex` and `pg-dump` daily at 03:00 UTC.

The worker runs under `tsx` in dev *and* prod — no compile step, deliberately (avoids
path-alias/ESM-extension breakage from tsc-emitted JS). The `@/` alias is resolved at
runtime from `tsconfig.json`, which is why the Dockerfile copies it into the **runtime**
stage; removing that COPY breaks the worker at boot, not at build. Sentry init must stay
the first import in `worker/index.ts` (`lib/queue.ts` registers `boss.on('error')` →
`Sentry.captureException`). Worker uses `@sentry/node`, web uses `@sentry/nextjs`.

**Nothing the worker imports may live outside the runtime image.** The same runtime alias
resolution cuts the other way: the runtime stage copies `worker/`, `lib/`, `prisma/`,
`auth.config.ts` and `tsconfig.json` — *not* `components/` or `app/`. So a single import
of `@/components/…` from anywhere in `lib/` crashes the container at boot with
`ERR_MODULE_NOT_FOUND` while `tsc --noEmit`, `next build` and every unit test stay green
— they all resolve against the full source tree. This took the worker down for five days
(#333 added `lib/embedding/canonicalize.ts` → `@/components/parts/kind-labels`); the web
container stayed healthy the whole time, so the only symptom was scheduled jobs quietly
not running. `pnpm lint:worker-graph` now walks the transitive graph from
`worker/index.ts` and checks each hop against the Dockerfile's own COPY lines. Shared
code belongs in `lib/` — that is the layer both sides already depend on.

**Both roles serve `/api/health` on port 3000.** The worker runs a small
`node:http` server (`worker/health-server.ts`) at the same path as web, started
*before* pg-boss so a worker wedged connecting to Postgres reports unhealthy
rather than being unprobeable. Same port is safe because containers have
separate network namespaces — that is what lets one `HEALTHCHECK` line in the
shared Dockerfile cover both services. Locally the two collide, so
`WORKER_HEALTH_PORT` overrides it for dev only. Health = dependencies ok **and**
the queue heartbeat fresh (`worker/heartbeat.ts`, 30s beat / 120s stale), so a
hung-but-alive worker goes unhealthy too. Note Docker only probes *running*
containers: a crash-loop never reports `unhealthy`, it stays `starting`, so
alerting must treat anything but `healthy` as down.

**Search and embeddings are eventually consistent by design.** `enqueueSearchIndex` and
`enqueueEmbed` swallow their errors and log a warning — a failed enqueue must never fail
the user's mutation. Recovery is the nightly `search.reindex` (rebuilds the single `house`
Meili index in place) and `embed.backfill` (fires at every worker boot, plus the admin
Rebuild button). Embeddings are gated on `ASK_ENABLED` at both producer and consumer, and
`VoyageRetryableError` is rethrown to let pg-boss retry while `VoyageFatalError` is
swallowed so it doesn't burn budget in a loop.

**Frontend.** Pages are server components — zero of the 42 `page.tsx` files carry
`'use client'`. Every page composes one of the shells in `app/(app)/_components/`:
`PageHeader`, `ListPageShell`, `FormPageShell`, `DetailPageShell`, plus
`components/EmptyState.tsx`. There is no generic DataTable — tables are per-domain
wrappers over `components/ui/table.tsx`. UI primitives are shadcn (`style: base-nova`)
backed by **`@base-ui/react`, not Radix** — so use the `render` prop, not `asChild`:
`<Button render={<Link href="/items/new" />}>`. Add primitives with
`pnpm dlx shadcn@latest add <name>` rather than hand-writing them, and install transitive
component deps explicitly (the CLI doesn't reliably pull them).

Tailwind v4 with no config file: tokens live in `app/globals.css` (`:root` raw palette
using `light-dark()`, then `@theme` mapping them to Tailwind/shadcn names). The `dark:`
variant is redefined there to fire on `prefers-color-scheme` **or** `[data-theme="dark"]`
— don't revert it to Tailwind's default or the theme toggle breaks.

## Rules that bite

### Do not collapse the TypeScript 6/7 aliases

`package.json` intentionally installs two TypeScript versions under aliased names:

```jsonc
"@typescript/native": "npm:typescript@7.0.2",       // Go port; provides bin `tsc`
"typescript": "npm:@typescript/typescript6@6.0.2",  // shim providing the TS 6 JS API
```

This looks like a mistake. It is not. **Do not "fix" it to a single `"typescript": "7.x"`
entry.**

TypeScript 7 is the Go rewrite: it ships a compiler but no JavaScript API. Next.js 16
loads `next.config.ts` *through* that API, as do Prisma, `@auth/prisma-adapter` and
shadcn. Collapsing the aliases means `lint`, `typecheck` and even `next build` still
pass, and then the **e2e/a11y jobs fail** with:

> It looks like you're trying to use TypeScript but do not have the required package(s) installed

followed by a 120s Playwright `webServer` timeout. The damage surfaces nowhere near the
change. See PR #281 (the broken bump) and #290 (this arrangement). If a Renovate PR
proposes changing either entry, check it preserves the split.

The aliases can be removed — in favour of a plain `"typescript": "7.x"` — once Next.js
supports TS 7 natively. Nothing else in this repo blocks that; it lints with Biome, so
there is no typescript-eslint dependency to wait on. Full rationale:
[`docs/README.md` § TypeScript toolchain](docs/README.md#typescript-toolchain).

**Next 16.3 met that condition, and broke the shim doing it.** Next added
`experimental.useTypeScriptCli` (vercel/next.js#95639) specifically to support TS 7 while
its JS API doesn't exist, then flipped it to default `true` (#96497). That switches the
probe Next uses to decide TypeScript is installed:

| `useTypeScriptCli` | Next probes | TS 7 | real TS 6 | **our TS 6 shim** |
|---|---|---|---|---|
| `false` (≤16.2 default) | `typescript/lib/typescript.js` | ✗ | ✓ | ✓ |
| `true` (16.3+ default) | `typescript/bin/tsc` | ✓ | ✓ | **✗ ships `bin/tsc6`** |

A *real* `typescript@6` would have sailed through — only the shim breaks, because it
renames its binary to `tsc6` to avoid colliding with a co-installed TS 7. The symptom is
identical to a collapsed alias (missing-package error → 120s `webServer` timeout → e2e
and a11y red, everything else green), so check *which* of the two you're looking at
before reaching for the fix.

`next.config.ts` sets `experimental.useTypeScriptCli: false` to hold the old behaviour.
That is Next's documented opt-out, not a hack. It must be removed in the same change that
collapses the aliases — the two settings are a matched pair, and `false` + TS 7 is the one
combination that hard-fails (`next build` exits: the JS API is unavailable).

The collapse is tracked in **#388**, which carries the full pre-flight checklist.

Collapsing is now genuinely unblocked on the Next side: 16.3 transpiles `next.config.ts`
via Node native type-stripping with an SWC fallback (`build/next-config-ts/transpile-config.js`),
not the TS API. Prisma and `@prisma/client` both declare `typescript` as an *optional*
peer. `@auth/prisma-adapter` and shadcn are unverified — confirm those before collapsing.

### Calendar dates are not instants

This is the repo's most expensive recurring bug class — fifteen bugs, eight fixes. The
rule is written out at the top of `lib/time/tz.ts`:

- **Instants** (`now`, `completedAt`, `receivedAt`, `archivedAt`) must be interpreted
  *through* the house timezone to find their day: `startOfDayUtc(instant, tz)`.
- **Calendar dates** (`nextDueOn`, `startsOn`, `endsOn`, `performedOn`, `purchaseDate`,
  `installDate`, `contractEndsOn` — every `@db.Date` column) are *already* a day. Read
  them in UTC. **Never run one through a timezone.**

`tzParts(nextDueOn, tz)` reads `2026-07-15T00:00:00Z` as "Jul 14" in Chicago and every
due date slides back a day. In the other direction, `performedOn: new Date()` at 8pm
Chicago stores *tomorrow* — a `date` column silently truncates a bad write to its UTC
day rather than rejecting it.

Two defenses exist, and both need maintaining when you add a `@db.Date` column:

1. The branded `CalendarDate` type, applied once at the DB boundary by a Prisma result
   extension in `lib/prisma-extensions.ts`. Add new date columns to that branding map.
2. The runtime write guard in `lib/calendar-date-guard.ts`, which recurses into nested
   relation writes (`reminder.create({ data: { targets: { create: [{ nextDueOn }] } } })`
   is exactly how targets are made). Add new columns to `CALENDAR_DATE_FIELDS` or the
   guard is silently blind to them.

`getHouseTimezone()` (`lib/house-profile/queries.ts`) reads the singleton
`HouseProfile.timezone` and answers exactly one question: *what day is it now*. For
display, `formatCalendarDate` (forces UTC) and `formatHouseDay` (instant → house day)
are **not** interchangeable. All wall-clock/offset/ISO-week math belongs in
`lib/time/tz.ts` — don't re-roll `Intl` parsing elsewhere.

Related: rrule numbers weekdays Mon=0..Sun=6 while JS uses Sun=0..Sat=6. Use the
`RRULE_WEEKDAY` map in `lib/reminders/recurrence.ts`; never pass a raw JS weekday to
`byweekday`.

### `app/(app)/` is the only auth boundary

`app/(app)/layout.tsx` does the `auth()` check and redirect. `middleware.ts` was removed
due to an Auth.js v5 JWE-vs-database-session incompatibility, so **a page created at top
level (e.g. `app/items/`) ships publicly with no auth and nothing will error.** New
protected routes must go under the `(app)` route group. Route handlers in `app/api/`
carry their own inline gate; the token-scoped `calendar/[token]` and
`inbound-email/[token]` routes are deliberately public.

### Migrations carry SQL that Prisma cannot regenerate

`prisma migrate diff` will not reproduce any of this — re-append it by hand if you ever
squash migrations, and eyeball every generated migration for DROPs of:

- **XOR `CHECK` constraints** on the multi-target join tables (`service_record_targets`,
  `warranty_targets`, `incoming_email_targets`) and on vendor links / attachment storage.
- **`NULLS NOT DISTINCT` unique indexes** on `(parentId, itemId, systemId)`. Prisma emits
  a plain `@@unique`, which under default Postgres semantics would *not* dedupe rows
  where one target column is NULL.
- **The IVFFlat pgvector index** on `embeddings`.

One deliberate exception: `reminder_targets` relaxed its XOR to "at most one" so an
unlinked chore can own a both-NULL standalone row carrying its cadence. That "only CHOREs
may do this" rule is enforced in `lib/reminders/actions.ts`, not by the database.

The dev DB is disposable — if a migration blocks, reset and reseed rather than doing
checksum surgery.

### Chores and reminders share a table

One `ReminderKind` discriminator, same recurrence, same targets. Chores are **never**
notified (`reminders-tick` filters `kind: 'REMINDER'`), may have zero targets, and honor
`autoComplete`; reminders require ≥1 target and have `autoComplete` coerced to `false`
server-side. Digests intentionally *do* include chores — that asymmetry is by design,
don't "fix" it with a kind filter.

### `pnpm lint` is three tools, and two of them surprise people

- **`lint:tokens`** (`scripts/lint-css-tokens.mjs`) asserts every `var(--token)` reference
  has a matching definition somewhere in the tree. A typo'd token resolves empty and
  silently drops the whole CSS declaration, which is why this exists. Tokens owned by
  upstream stylesheets must go in the `EXTERNAL_TOKENS` allow-list.
- **`lint:knip`** flags unused files, exports, and deps across the full import graph. It
  runs on **pre-push**, not pre-commit, because mid-branch exports are legitimately
  transient. It most often trips on a speculatively-exported schema or a new
  entry-shaped file missing from the `entry` array in `knip.json`. `components/ui/**` is
  ignored, so unused shadcn primitives are fine.

Never `--no-verify`. If a hook blocks, fix the hook or the issue. Note that `git commit`
can fail *silently* behind the Biome pre-commit hook — verify HEAD actually moved.

### Playwright gotcha

Click the `label[for="…"]`, not the bare `RadioGroupItem` — the underlying control is
visually collapsed and Playwright errors with "outside of viewport". See the target
pickers in `tests/e2e/systems.spec.ts`.

Visual-regression baselines are platform-pinned to the linux Playwright image and must
only be regenerated through `pnpm test:visual:update` (the dockerized harness). Baselines
generated on macOS will diff on every subsequent run.

**After any `@playwright/test` bump, run `pnpm exec playwright install`.** The version
has to agree in three independent places, and only CI fixes itself:

| Where | Kept in sync by |
|---|---|
| CI | the workflow runs `playwright install` every job |
| `tests/e2e/visual.Dockerfile` | Renovate — grouped with the npm client under `groupName: playwright` (#324) so the image and the client can only move together |
| **your machine's `~/Library/Caches/ms-playwright`** | **nothing — do it by hand** |

All three fail the same unhelpful way, pointing at a missing binary rather than at a
version mismatch:

```
Error: browserType.launch: Executable doesn't exist at
  …/chromium_headless_shell-1234/chrome-headless-shell
```

If that appears right after a dependency update, it is a stale browser cache, not a
broken test. It bit both the dockerized harness (#325) and the host in the same session.

## Conventions

- **Dependency pinning:** every dep is pinned to an exact version (`x.y.z`, no range
  prefix) — as are `engines` and `packageManager`. `pnpm-workspace.yaml` enforces
  `savePrefix: ""`, and the shared Renovate preset (`github>owine/renovate-config`) uses
  `rangeStrategy: "pin"`. Renovate drives updates; don't hand-edit versions or
  reintroduce `~`/`^`. Verify a dep is on its current major and actively maintained
  before adding it.
- **pnpm settings live in `pnpm-workspace.yaml`, not `.npmrc`.** pnpm 11 reads only
  registry, authentication and certificate settings from INI files; every other key
  there is silently ignored — no warning, no error. This repo had four inert keys in a
  root `.npmrc` for exactly that reason; the file is gone. Add settings in
  `pnpm-workspace.yaml` (camelCase) and confirm with `pnpm config get <key>` — a
  setting that answers `undefined` is not in effect.
- **Release-age soak belongs to Renovate.** The shared preset gates every update on age
  (3 days minor/patch, 7 days majors, 0 for CVEs and lockfile maintenance). Do not add
  `minimumReleaseAge` here. A pnpm-side soak double-gates against Renovate: Renovate's
  gate decides when a PR opens, pnpm's decides when a lockfile can be written, so a
  release in the gap gets bumped in `package.json` and then refused by the resolver —
  `renovate/artifacts` fails, the lockfile goes stale, and `--frozen-lockfile` rejects
  the PR. The 0-day CVE tier fails hardest. `pnpm-workspace.yaml` carries the full
  rationale. `preferFrozenLockfile: true` makes a stale `pnpm-lock.yaml` fail CI rather
  than silently self-repair, which is why a long-lived branch should be rebased before
  merge.
- **Env:** `lib/env.ts` exports a lazy Zod-validated `getEnv()`. Lazy is deliberate —
  eager validation breaks tests at import time.
- **Logging:** secrets are scrubbed centrally in `lib/logger.ts` + `lib/log-scrub.ts`
  (known keys redacted, values pattern-scrubbed). Don't re-roll per-site redaction.
- **Commits:** SSH-signed via 1Password (`commit.gpgsign=true`).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
