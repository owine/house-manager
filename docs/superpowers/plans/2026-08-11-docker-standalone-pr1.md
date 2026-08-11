# Docker Standalone Output (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the web role to Next's `output: 'standalone'` server, remove pnpm from the runtime image, and add a CI smoke test that boots both roles from the actually-built image — so that PR2 can safely prune `node_modules`.

**Architecture:** `next build` gains `output: 'standalone'`, emitting a self-contained `server.js` plus a file-traced `node_modules`. That bundle is copied to `/app/web/` in the runtime stage, keeping it away from `/app/node_modules` (pnpm's symlinked store) which the worker continues to use. Web runs `node web/server.js`; both roles invoke tooling through `node_modules/.bin/` since pnpm no longer ships.

**Tech Stack:** Next.js 16.3, Docker BuildKit multi-stage, docker/build-push-action v7, bash, curl.

**Spec:** `docs/superpowers/specs/2026-08-11-docker-image-size-design.md`

---

## Background the implementer needs

**This PR was expected to leave the image roughly neutral in size** — `/app/web` added while the top-level `.next` COPY (84 MB) and corepack/pnpm (40 MB) are removed. Measured reality beat that: **2.22 GB → 1.74 GB, about −480 MB**, because `.next/standalone` is nested *inside* `.next`, so replacing the wholesale `COPY /app/.next` dropped both the old build output and an accidental duplicate of the bundle, on top of the ~40 MB pnpm shim. The further ~405 MB from pruning `/app/node_modules` is still PR2's.

**Why the two-directory layout.** Standalone emits its own self-contained `node_modules` — under pnpm it reproduces a `.pnpm` symlink structure of its own, with relative links that stay inside the bundle, so it copies cleanly as a unit. It is nonetheless a *separately generated store* from `/app/node_modules`, and both want the same path. Merging two independently-built stores fails subtly, so standalone goes to `/app/web/` and the worker keeps `/app/node_modules`. The ~37 MB of overlap is the price of staying on one image.

**Node resolves modules upward, and that will hide bugs from you.** `/app/web/server.js` failing to find a package in `/app/web/node_modules` will silently find it in `/app/node_modules`. In this PR the sibling tree is still complete, so *anything standalone failed to trace still works*. PR2's prune is what deletes it. This is exactly why the smoke test must assert a **dynamically rendered page**, not just `/api/health` — health never exercises the React render path. Note the not-found page does not count: it is a build-time prerender served from disk, so the smoke script probes `/` (which runs `auth()` and the RSC path) as its render check.

**`prisma`, `tsx` and `typescript` must stay reachable.** Web boot runs `prisma migrate deploy` and `tsx prisma/seed.ts`. `prisma.config.ts` is TypeScript, so the Prisma CLI needs a TS loader at runtime.

**Repo conventions that apply:**
- `pnpm`, never `npx`/`npm`.
- Never `--no-verify`. `git commit` can fail *silently* behind the Biome pre-commit hook — **verify `HEAD` actually moved** after every commit.
- Run `pnpm verify` before pushing.
- Do **not** use a git worktree in this repo — knip hangs forever and blocks pre-push, and the missing `.env` makes `prisma generate` and typecheck fail misleadingly. Work in the main checkout.
- `pnpm lint:worker-graph` parses `COPY --from=… ./<dest>` lines out of the Dockerfile. Changing COPY shapes can break its regex — it fails loudly with "parsed zero COPY targets" if so.

**Out of scope — handoff, not a task.** The production compose lives in a separate GitOps repo. Its required delta is documented in the spec under *Production compose handoff*. Do not attempt to change it.

## File structure

| File | Responsibility |
|---|---|
| `scripts/smoke-image.sh` *(create)* | Boots both roles from a built image against pgvector and asserts health, a `public/` asset, the prerendered app output, and a genuinely dynamic render. The safety net for this PR and PR2. |
| `next.config.ts` *(modify)* | Adds `output: 'standalone'`. |
| `Dockerfile` *(modify)* | Build stage assembles the standalone bundle; runtime stage copies `/app/web`, drops the top-level `.next`, corepack/pnpm and `pnpm-workspace.yaml`, adds `HOSTNAME`/`PORT`, changes `CMD`. |
| `docker-compose.yml` *(modify)* | Both `command:` lines move off pnpm. |
| `.github/workflows/ci.yml` *(modify)* | `build-image` gains a cache-replayed `--load` build plus a smoke step. |
| `CLAUDE.md` *(modify)* | Documents the two-tree layout and the upward-resolution hazard. |
| `docs/README.md` *(modify)* | Deployment section: new start commands. |

---

## Task 1: Smoke script, proven against the current image

The smoke script is this PR's test. Write it first and get it green against the **unchanged** image, so that later failures are attributable to your changes rather than to the script.

**Files:**
- Create: `scripts/smoke-image.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Boots both roles from a built image and asserts they actually serve.
#
# This is the safety net for the standalone/prune work. `/api/health` alone is
# NOT sufficient: it returns 200 even when public/ and .next/static are missing.
# Nor is the not-found page enough — that is a build-time prerender served from
# disk. The `/` probe below is the ONLY check here that exercises the React
# render path; the others assert that specific build outputs shipped and are
# actually served.
#
# Usage: scripts/smoke-image.sh <image-tag>
set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh <image-tag>}"
NET="smoke-$$"
PG="smoke-pg-$$"
WEB="smoke-web-$$"
WORKER="smoke-worker-$$"

# pgvector, NOT plain postgres: the squashed migration does CREATE EXTENSION
# and `migrate deploy` fails without it. Matches tests/integration/setup.ts.
PG_IMAGE="pgvector/pgvector:pg18"

cleanup() {
  docker rm -f "$WEB" "$WORKER" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
# INT/TERM as well as EXIT: with EXIT alone, Ctrl-C leaves three containers and
# a network behind.
trap cleanup EXIT INT TERM

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# Assert the image is in the local daemon, and run with --pull=never below.
# Without both, `docker run` silently pulls: in CI the classic
# docker/build-push-action footgun is building without `load: true`, leaving the
# image only in the buildx cache, so the script would pull the *published* GHCR
# tag and smoke a stale image to a green PASS — a false green on exactly the
# change this gates.
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image not present locally: $IMAGE"

# Polls health, but bails out early if the container has exited. Without the
# liveness check a container that dies at t=1s burns the full ~180s and then
# reports "never returned 200", which misdescribes a crash as a timeout.
#
# Bounded by wall clock, not iteration count. With `-m 5` per probe plus a 2s
# sleep, 90 iterations would be ~10.5 min per role / ~21 min across both against
# a server that accepts connections and never answers — past the CI step's
# timeout-minutes, so GitHub would kill the job and no `docker logs` would ever
# be dumped. Failing cleanly ourselves at 180s gives strictly better diagnostics.
wait_for_health() {
  local name="$1" port="$2"
  local deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -fsS -m 5 "http://localhost:$port/api/health" >/dev/null 2>&1 && return 0
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then
      docker logs "$name" >&2
      fail "$name exited during boot before serving /api/health"
    fi
    sleep 2
  done
  docker logs "$name" >&2
  fail "$name /api/health never returned 200 within 180s"
}

# The full set lib/env.ts validates. Missing any of these makes both roles
# crash-loop at boot on Zod validation rather than failing usefully.
env_args=(
  -e "DATABASE_URL=postgresql://smoke:smoke@$PG:5432/smoke"
  -e "AUTH_SECRET=smokesecretsmokesecretsmokesecretsmoke"
  -e "AUTH_URL=http://localhost:3000"
  -e "AUTH_OIDC_ISSUER=https://auth.example.com"
  -e "AUTH_OIDC_CLIENT_ID=smoke"
  -e "AUTH_OIDC_CLIENT_SECRET=smoke"
  -e "MEILI_HOST=http://localhost:7700"
  -e "MEILI_KEY=smoke"
  -e "FILES_DIR=/data/files"
  -e "NODE_ENV=production"
  -e "WEB_PUSH_VAPID_PUBLIC_KEY=smoke-vapid-public-key-placeholder"
  -e "WEB_PUSH_VAPID_PRIVATE_KEY=smoke-vapid-private-key-placeholder"
  -e "WEB_PUSH_CONTACT_EMAIL=mailto:smoke@example.com"
  -e "FORWARDEMAIL_API_KEY=smoke-forwardemail-key"
  -e "FORWARDEMAIL_FROM_ADDRESS=smoke@example.com"
  -e "ANTHROPIC_API_KEY=placeholder-smoke"
)

echo "→ starting $PG_IMAGE"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=smoke -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=smoke \
  "$PG_IMAGE" >/dev/null

# Query rather than pg_isready: pg_isready succeeds against the temporary init
# server that the entrypoint then shuts down and restarts, so it can go ready,
# unready, ready again.
for _ in $(seq 60); do
  docker exec "$PG" psql -U smoke -d smoke -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" psql -U smoke -d smoke -c 'select 1' >/dev/null 2>&1 || {
  docker logs "$PG" >&2; fail "postgres never became ready"
}

echo "→ starting web"
docker run -d --name "$WEB" --network "$NET" --pull=never -p 13000:3000 "${env_args[@]}" \
  "$IMAGE" sh -c "$WEB_CMD" >/dev/null

wait_for_health "$WEB" 13000
echo "  ✓ web /api/health"

# public/ asset. Deliberately /sw.js and NOT /icon.png: app/icon.png exists
# alongside public/icon.png, so Next generates a metadata route
# ("/icon.png/route" in .next/server/app-paths-manifest.json) that serves
# identical bytes from .next. /icon.png therefore returns 200 with public/
# entirely absent — a vacuous check. Of public/'s four entries (authelia.svg,
# brand/, icon.png, sw.js) only icon.png has an app/ twin; /sw.js correctly
# 404s when public/ is missing.
curl -fsS -m 15 -o /dev/null http://localhost:13000/sw.js || {
  docker logs "$WEB" >&2; fail "public/sw.js did not resolve"
}
echo "  ✓ public/sw.js"

# Not-found page. NOTE: this is a build-time prerender — .next/server/
# _not-found.html served with `x-nextjs-cache: HIT` / `x-nextjs-prerender: 1`,
# i.e. a file read, not a render. It is worth keeping because it proves the
# .next/server app output shipped and is being served (a real standalone
# footgun), but it must NOT be trusted as the render-path check. The dynamic
# check below is what actually exercises React.
#
# NOTE: no `-f` here. Next returns 404 for this route, and `curl -f` exits
# non-zero and prints NOTHING on 4xx — with -f the body is always empty and
# this check can never pass.
body="$(curl -sS -m 15 "http://localhost:13000/smoke-nonexistent-$$" || true)"
case "$body" in
  *"Page Not Found"*) echo "  ✓ prerendered app output served" ;;
  *) docker logs "$WEB" >&2; fail "not-found page did not render (got ${#body} bytes)" ;;
esac

# Genuinely dynamic render. `/` is not prerendered: it loads the per-route
# server chunk, runs auth() and goes through the RSC path, then redirects to
# signin. This is the check that catches a pruned react-dom/scheduler or a
# server chunk missing from the standalone bundle — a 500 here is unmissable,
# whereas every check above can pass on file reads alone.
#
# It does NOT prove the render path can reach the database: with no session
# cookie auth() short-circuits before any adapter call, loading the Prisma
# client module but issuing no query. /api/health covers DB reachability.
#
# The no-store assertion guards the coupling that makes this check meaningful:
# `/` is dynamic only because it is absent from prerender-manifest.json. Were it
# to become prerenderable (`export const dynamic = 'force-static'`, say), this
# would silently degrade into one more file read, exactly like the not-found
# check above. Asserting the header makes that self-checking rather than a
# comment nobody re-reads.
#
# -D - puts the headers on stdout ahead of the -w line, so one request yields
# both without a temp file. `|| true` keeps a transport failure on the fail
# path (empty fields) instead of tripping set -e.
probe="$(curl -sS -m 15 -o /dev/null -D - -w '\nSMOKE-W %{http_code} %{redirect_url}\n' "http://localhost:13000/" || true)"
read -r _ code redirect <<<"$(printf '%s\n' "$probe" | grep '^SMOKE-W ' || true)"
cache="$(printf '%s\n' "$probe" | tr -d '\r' | grep -i '^cache-control:' || true)"
case "$code:$redirect" in
  307:*"/api/auth/signin") ;;
  *) docker logs "$WEB" >&2; fail "dynamic route / returned '$code' '$redirect'" ;;
esac
case "$cache" in
  *no-store*) echo "  ✓ dynamic render (/ → signin, no-store)" ;;
  *) docker logs "$WEB" >&2; fail "/ is no longer dynamic — expected no-store, got '$cache'" ;;
esac

# .next/static — the rendered HTML references hashed chunk URLs, so pull one out
# and fetch it. Without this the suite would pass with static assets missing:
# the HTML still returns 200, only its <script>/<link> targets 404.
chunk="$(printf '%s' "$body" | grep -o '/_next/static/[^"\\]*' | head -1 || true)"
[ -n "$chunk" ] || { docker logs "$WEB" >&2; fail "no /_next/static URL in rendered HTML"; }
curl -fsS -m 15 -o /dev/null "http://localhost:13000$chunk" || {
  docker logs "$WEB" >&2; fail ".next/static asset did not resolve: $chunk"
}
echo "  ✓ .next/static asset ($chunk)"

echo "→ starting worker"
docker run -d --name "$WORKER" --network "$NET" --pull=never -p 13001:3000 "${env_args[@]}" \
  "$IMAGE" sh -c "$WORKER_CMD" >/dev/null

# The strongest check in this file, but only by coupling: worker/index.ts calls
# `await heartbeat.beat()` AFTER all 13 boss.work/boss.schedule registrations,
# and resolveStatus() (worker/health-server.ts) returns 'starting' → 503 while
# ageMs === null. So a 200 here means every job actually registered, not merely
# that the process booted. A future "go healthy sooner" refactor that moves
# beat() above the registrations would silently downgrade this check to "the
# process started" without failing — keep the two in this order.
wait_for_health "$WORKER" 13001
echo "  ✓ worker /api/health"

echo "SMOKE PASS: $IMAGE"
```

- [ ] **Step 2: Add the current-image commands at the top**

Insert directly after the `PG_IMAGE=` line. These are the **pre-change** commands and get updated in Task 5 — that update is what makes this a red/green loop rather than a rubber stamp.

```bash
# Role commands. The image ships no pnpm, and nothing puts node_modules/.bin
# on PATH, so both roles are invoked by explicit path.
#
# These are duplicated in docker-compose.yml, in docs/README.md § Production,
# and in the production GitOps compose. Change one, change all four. This copy
# is the only one under automated test — CI runs this script against the real
# image on every build — so if they drift, this is the one that stays right
# and compose is the one that silently breaks.
WEB_CMD="${WEB_CMD:-node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx prisma/seed.ts && node web/server.js}"
WORKER_CMD="${WORKER_CMD:-node_modules/.bin/tsx worker/index.ts}"
```

- [ ] **Step 3: Make it executable and build the current image**

```bash
chmod +x scripts/smoke-image.sh
docker build -t house-manager:smoke .
```
Expected: build succeeds.

- [ ] **Step 4: Run the smoke test against the unchanged image**

```bash
./scripts/smoke-image.sh house-manager:smoke
```
Expected: `SMOKE PASS`, with all six ✓ lines (web health, `sw.js`, prerendered
app output, dynamic render, `.next/static` chunk, worker health).

**If this fails, stop.** The script is wrong, not the image. A green baseline here is the whole point of doing this task first.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-image.sh
git commit -m "test(docker): smoke-test the built image's two roles

Boots web and worker from a built image against pgvector and asserts
health, a public/ asset, and both prerendered and dynamically rendered
output. The dynamic check (/ -> signin) is the load-bearing one: it is the
only one that exercises the React render path, since /api/health returns
200 with public/ and .next/static missing and the not-found page is a
build-time prerender served from disk. The public/ probe uses sw.js, not
icon.png -- app/icon.png generates a metadata route that serves 200 with
public/ absent entirely.

Green against the current image; the role commands change in the
standalone switch."
git rev-parse --short HEAD   # verify HEAD moved
```

---

## Task 2: Enable standalone output

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Add the output mode**

In `next.config.ts`, inside `nextConfig`, above `typescript:`:

```ts
  // Emits .next/standalone: a self-contained server.js plus a file-traced
  // node_modules holding only what the app actually imports. The Dockerfile
  // copies that to /app/web, which is what lets /app/node_modules be pruned
  // to the worker's closure in a follow-up.
  output: 'standalone',
```

- [ ] **Step 2: Build and confirm the trace root**

```bash
pnpm build
ls .next/standalone
```
Expected: contains `server.js`, `node_modules/`, `.next/`, `package.json`.

**If instead you see a single nested directory** (e.g. `.next/standalone/Users/...` or `.next/standalone/app/...`), Next inferred a trace root above the repo. Add `outputFileTracingRoot: import.meta.dirname` alongside `output` and rebuild until `server.js` sits directly in `.next/standalone/`. The Dockerfile's `COPY` assumes the flat shape; a nested one produces a silently wrong tree.

- [ ] **Step 3: Verify the traced tree has what the render path needs**

```bash
ls .next/standalone/node_modules | head -20
ls .next/standalone/node_modules/next >/dev/null && echo "next: ok"
ls .next/standalone/node_modules/react-dom >/dev/null && echo "react-dom: ok"
```
Expected: both `ok` lines.

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git commit -m "build(next): emit standalone output

Next traces the real import graph at build time and can emit a
self-contained server plus only the files the app imports. Currently the
Dockerfile ships every production dependency instead.

No behaviour change on its own — the Dockerfile consumes this next."
git rev-parse --short HEAD
```

---

## Task 3: Assemble the standalone bundle in the build stage

Next deliberately omits `public/` and `.next/static` from standalone; they must be copied in or the app serves no assets.

**Files:**
- Modify: `Dockerfile` (build stage, after the `pnpm build` RUN)

- [ ] **Step 1: Add the assembly step**

Immediately after the `RUN --mount=type=secret,…  pnpm build` block and **before** `RUN pnpm prune --prod`:

```dockerfile
# Next deliberately excludes public/ and .next/static from standalone output —
# server.js expects them to have been copied in. Without this the app boots and
# serves 200s while every asset and stylesheet 404s.
RUN cp -r public .next/standalone/ \
 && cp -r .next/static .next/standalone/.next/
```

- [ ] **Step 2: Build and verify the bundle shape**

```bash
docker build -t house-manager:smoke .
docker run --rm --entrypoint sh house-manager:smoke -c \
  'ls /app/.next/standalone 2>/dev/null || echo "(not in runtime yet — expected)"'
```
Expected: `(not in runtime yet — expected)` — the runtime stage does not copy it until Task 4. The build succeeding is the real assertion here.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): assemble public/ and static into standalone bundle

Next excludes both from standalone output by design; server.js expects
them copied in. Without this the app returns 200s while every asset 404s
— which /api/health would not catch."
git rev-parse --short HEAD
```

---

## Task 4: Restructure the runtime stage

**Files:**
- Modify: `Dockerfile` (runtime stage)

- [ ] **Step 1: Remove corepack/pnpm from the runtime stage**

From the **runtime** stage only (leave the `base` stage's copy alone — `next build` needs pnpm), delete all four of:

```dockerfile
# renovate: datasource=npm depName=pnpm
# Keep in sync with the base stage and package.json "packageManager" — see
# comment on the base stage's PNPM_VERSION arg.
ARG PNPM_VERSION=11.20.0
RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate
```

**Delete the `# renovate:` annotation too.** Left orphaned above a non-pnpm line it would point Renovate at the wrong thing. The `base` stage keeps its own annotated copy, so pnpm stays tracked.

- [ ] **Step 2: Replace the two application COPY blocks**

Replace:

```dockerfile
# Next.js build output
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
```

with:

```dockerfile
# Web role: Next standalone bundle — server.js plus a file-traced node_modules
# holding only what the app imports. Under pnpm this tree reproduces its own
# .pnpm symlink structure; the links are relative and stay inside ./web, so it
# copies cleanly. Deliberately NOT merged into /app/node_modules: they are two
# independently-generated stores and merging them fails in subtle ways.
#
# Beware when debugging: Node resolves upward, so a package missing from
# web/node_modules silently resolves from /app/node_modules instead. Anything
# standalone failed to trace still works today and breaks only once
# /app/node_modules is pruned. scripts/smoke-image.sh probes / for a real
# dynamic render rather than just /api/health for exactly this reason.
COPY --from=build /app/.next/standalone ./web
```

- [ ] **Step 3: Drop the now-unused workspace manifest**

Remove:

```dockerfile
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
```

Nothing reads it once pnpm is gone. Keep `tsconfig.json` — `tsx` resolves the `@/` alias from it at boot.

- [ ] **Step 4: Add the standalone server's env**

After `ENV NEXT_TELEMETRY_DISABLED=1`:

```dockerfile
# standalone's server.js binds localhost unless told otherwise, which would
# leave the HEALTHCHECK curl (and everything else outside the container)
# hitting a port nothing is listening on.
# NOTE: this shadows the conventional container-hostname variable. pino is
# unaffected (it reads os.hostname()), but anything keying off $HOSTNAME sees
# 0.0.0.0.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
```

- [ ] **Step 5: Change the CMD**

Replace `CMD ["pnpm", "start"]` with:

```dockerfile
# `next start` no longer exists in this image — standalone ships its own
# server. Production compose must change its command in the same window; see
# docs/superpowers/specs/2026-08-11-docker-image-size-design.md
# § Production compose handoff.
CMD ["node", "web/server.js"]
```

- [ ] **Step 6: Verify the worker-graph guard still parses the Dockerfile**

```bash
pnpm lint:worker-graph
```
Expected: `lint:worker-graph — OK (72 modules reachable …)`.

If it reports **"parsed zero COPY targets"**, your COPY edits broke its regex (`scripts/lint-worker-runtime-graph.mjs:52`) — fix the regex, not by reverting.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): run web from the standalone server

Copies the standalone bundle to /app/web and drops the top-level .next
COPY it supersedes. Removes corepack/pnpm and pnpm-workspace.yaml from
the runtime stage — nothing reads them once CMD is node web/server.js.

Adds HOSTNAME=0.0.0.0 so the server binds outside localhost, without
which the HEALTHCHECK curl cannot reach it.

BREAKING: the image no longer has pnpm or next start. Production compose
must change its command in the same window."
git rev-parse --short HEAD
```

---

## Task 5: Point the smoke test at the new commands and prove it green

This is the red/green moment. The commands from Task 1 now describe an image that no longer exists.

**Files:**
- Modify: `scripts/smoke-image.sh`

- [ ] **Step 1: Confirm the old commands now fail**

```bash
docker build -t house-manager:smoke .
./scripts/smoke-image.sh house-manager:smoke
```
Expected: **FAIL** — web never becomes healthy, and `docker logs` shows `pnpm: not found`.

This failure is the point. If it *passes*, pnpm is still in the runtime stage and Task 4 Step 1 was not applied.

- [ ] **Step 2: Update the role commands**

```bash
# Role commands. The image ships no pnpm, and nothing puts node_modules/.bin
# on PATH, so both roles are invoked by explicit path.
#
# These are duplicated in docker-compose.yml, in docs/README.md § Production,
# and in the production GitOps compose. Change one, change all four. This copy
# is the only one under automated test — CI runs this script against the real
# image on every build — so if they drift, this is the one that stays right
# and compose is the one that silently breaks.
WEB_CMD="${WEB_CMD:-node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx prisma/seed.ts && node web/server.js}"
WORKER_CMD="${WORKER_CMD:-node_modules/.bin/tsx worker/index.ts}"
```

Paths are explicit because nothing puts `node_modules/.bin` on `PATH` once pnpm is gone.

- [ ] **Step 3: Run it green**

```bash
./scripts/smoke-image.sh house-manager:smoke
```
Expected: `SMOKE PASS` with all six ✓ lines.

The `✓ dynamic render (/ → signin, no-store)` line is the one that matters — it is the only check that exercises the React render path, not merely a health probe or a file read. The `✓ prerendered app output served` (not-found) line is retained only as evidence that `.next/server` app output shipped and is being served — it is a build-time prerender read from disk, not a render.

- [ ] **Step 4: Record the size for comparison**

```bash
docker images house-manager:smoke --format '{{.Size}}'
```
Note it in the PR description. Measured: **2.22 GB → 1.74 GB, about −480 MB** — `.next/standalone` is nested *inside* `.next`, so replacing the wholesale `COPY /app/.next` dropped both the old build output and an accidental duplicate of the bundle, on top of the ~40 MB pnpm shim. The further ~405 MB from pruning `/app/node_modules` is still PR2's.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-image.sh
git commit -m "test(docker): smoke against the standalone start commands

The image no longer ships pnpm, and nothing puts node_modules/.bin on
PATH, so both roles are invoked by explicit path."
git rev-parse --short HEAD
```

---

## Task 6: Update the in-repo compose

**Files:**
- Modify: `docker-compose.yml:79` and `:94`

- [ ] **Step 1: web**

```yaml
    command: sh -c "node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx prisma/seed.ts && node web/server.js"
```

- [ ] **Step 2: worker**

```yaml
    command: node_modules/.bin/tsx worker/index.ts
```

- [ ] **Step 3: Verify the real stack comes up**

If `db` and `meilisearch` are already running (e.g. a live dev stack), only
start the two services under test — `docker compose up -d --build db
meilisearch web worker` is fine on a cold checkout, but don't reach for
`docker compose down` afterward: it stops every service in the file, not just
the ones you started, and would take out a developer's already-running `db`
and `meilisearch` along with it.

```bash
docker compose up -d --build web worker
```
Poll rather than assuming — the image's HEALTHCHECK has a 120s start-period,
so allow up to ~2–3 minutes before concluding anything:

```bash
until docker compose ps web worker --format '{{.Status}}' | grep -c '(healthy)' | grep -q 2; do
  sleep 5
done
docker compose ps
```
Expected: `web` and `worker` both `Up` and `(healthy)`. Also confirm web
actually serves: `curl -fsS http://localhost:3000/api/health`.

Tear down only what you started, and confirm `db`/`meilisearch` are still up:

```bash
docker compose rm -sf web worker
docker compose ps
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "build(compose): invoke prisma/tsx by path, run standalone server

Matches the image, which no longer ships pnpm. The production compose in
the GitOps repo needs the same two lines — see the spec's
'Production compose handoff'."
git rev-parse --short HEAD
```

---

## Task 7: Wire the smoke test into CI

`build-image` uses an explicit `outputs:` with `push-by-digest`, so `load: true` is **not** a drop-in. Add a second build that produces a local tag. It runs against the same buildx builder in the same job, so no layer is recompiled — but the `load` export of a multi-hundred-MB image into the docker daemon takes minutes, not seconds. Both new steps therefore carry `timeout-minutes`.

**Files:**
- Modify: `.github/workflows/ci.yml` (`build-image` job)

- [ ] **Step 1: Add the load + smoke steps**

Directly after the `Build and push by digest` step and **before** `Export digest`:

```yaml
      # The build above uses an explicit `outputs:` with push-by-digest, so the
      # image is never tagged locally and `load: true` is not a drop-in. This
      # second invocation runs against the same buildx builder in the same job,
      # so every layer is already in buildkit's local cache and nothing is
      # recompiled (cache-from is belt-and-braces). The cost is the `load`
      # export of the image into the docker daemon, which is minutes, not
      # seconds — hence the timeout below.
      - name: Load image locally for smoke test
        timeout-minutes: 15
        uses: docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a # v7.3.0
        with:
          context: .
          platforms: ${{ matrix.platform }}
          build-args: |
            GIT_SHA=${{ github.sha }}
          load: true
          tags: house-manager:smoke
          cache-from: type=gha,scope=${{ matrix.platform }}
      # Boots both roles from the image that was actually built. Guards the
      # standalone bundle and (in the follow-up PR) the pruned worker tree.
      - name: Smoke test the image
        timeout-minutes: 10
        run: ./scripts/smoke-image.sh house-manager:smoke
```

Both steps carry a `timeout-minutes` so a wedged container fails in minutes
rather than burning toward the 6-hour job limit.

Safe on both matrix legs: each builds a single platform on a native runner, so there is no multi-arch `load` conflict.

- [ ] **Step 2: Validate the workflow parses**

```bash
pnpm exec biome check .github/workflows/ci.yml 2>/dev/null || true
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: smoke-test the built image in build-image

Boots both roles from the image CI just produced. The existing build uses
push-by-digest with an explicit outputs:, so load: true is not a drop-in
— a second build reuses the builder's local cache instead. Nothing
recompiles; the cost is the load export into the docker daemon.

This is the safety net the node_modules prune depends on."
git rev-parse --short HEAD
```

---

## Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/README.md`

- [ ] **Step 1: CLAUDE.md — add after the "Nothing the worker imports…" paragraph**

```markdown
**The runtime image carries two dependency trees.** `/app/web/node_modules` is
Next's file-traced standalone bundle (web only; under pnpm it reproduces its
own `.pnpm` symlink structure, with relative links that stay inside `web/`);
`/app/node_modules` is
pnpm's symlinked store (worker, plus `prisma`/`tsx` at boot). They are
deliberately not merged — the layouts differ and merging them fails subtly.

The hazard is that **Node resolves upward**: a package missing from
`web/node_modules` silently resolves from `/app/node_modules` instead. So a
gap in the standalone bundle is invisible until that sibling tree is pruned.
`scripts/smoke-image.sh` probes `/` for a real *dynamic render*, not just
`/api/health`, because health never exercises the React render path (and the
not-found page is a prerender served from disk).

The image ships no pnpm. Both roles invoke tooling by explicit path
(`node_modules/.bin/tsx`, `node_modules/.bin/prisma`); web runs
`node web/server.js`, not `next start`.
```

- [ ] **Step 2: docs/README.md — update the deployment/start commands**

Find the section documenting how the containers start and replace any `pnpm start` / `pnpm worker:start` with the explicit-path commands, adding:

```markdown
The image contains no pnpm. Production compose must invoke:

- web: `sh -c "node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx prisma/seed.ts && node web/server.js"`
- worker: `node_modules/.bin/tsx worker/index.ts`
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/README.md
git commit -m "docs: two-tree runtime layout and the upward-resolution hazard

The gap that matters is invisible by construction: Node resolves upward,
so anything standalone failed to trace still works until the sibling
pnpm tree is pruned."
git rev-parse --short HEAD
```

---

## Task 9: Full verification before pushing

- [ ] **Step 1: Repo checks**

```bash
pnpm verify
```
Expected: lint, typecheck and unit tests all pass.

- [ ] **Step 2: Full local suite**

```bash
pnpm test:local
```
Expected: pass. CI runs only `@critical` e2e and does not enforce the coverage floor — this is the gate that does.

- [ ] **Step 3: Final smoke against a clean build**

```bash
docker build -t house-manager:smoke .
./scripts/smoke-image.sh house-manager:smoke
```
Expected: `SMOKE PASS`.

- [ ] **Step 4: Push and open the PR**

Include in the description: measured image size before and after, and an explicit note that **production compose must be updated in the same window** (link the spec's *Production compose handoff*).

Follow the repo's PR workflow: watch the `Sourcery review` check, address its comments, then `gh pr merge --auto --squash`, then `gh pr checks --watch --fail-fast`.

---

## Done when

- [ ] `scripts/smoke-image.sh` passes against a locally built image
- [ ] CI's `build-image` runs the smoke test on both platforms
- [ ] `pnpm lint:worker-graph` still parses the Dockerfile and reports OK
- [ ] `pnpm test:local` passes
- [ ] The image contains no `pnpm` binary and no top-level `/app/.next`
- [ ] The PR description states the production compose delta
