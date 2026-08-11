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

# Role commands. Updated when the image stops shipping pnpm (see PR1 Task 5).
WEB_CMD="${WEB_CMD:-pnpm db:deploy && pnpm db:seed && pnpm start}"
WORKER_CMD="${WORKER_CMD:-pnpm worker:start}"

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
