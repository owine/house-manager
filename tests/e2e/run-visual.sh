#!/usr/bin/env bash
# Run the visual + layout suite locally inside a linux container so the
# baselines stay platform-pinned (macOS-native Playwright would diff against
# the linux baselines forever).
#
# Topology — most services run on the HOST, Playwright runs in the CONTAINER:
#   host  :3000  next dev          ← container → host.docker.internal:3000
#   host  :9999  mock-OIDC         ← container browser hits the issuer here
#   host  :5432  postgres          (docker compose up -d db)
#   host  :7700  meilisearch       (docker compose up -d meilisearch)
#   host         pg-boss worker    (replicates global-setup.ts)
#   ctr          playwright test   visual.spec.ts only
#
# Steps:
#   1. Source the shared env block (tests/e2e/_env-local.sh) with
#      E2E_AUTH_HOST=host.docker.internal so the dev server + Auth.js issue
#      URLs the container can reach.
#   2. db:deploy + seed on the host (global-setup is disabled when
#      PLAYWRIGHT_BASE_URL is set — see playwright.config.ts).
#   3. Start mock-OIDC + worker + dev server on the host. Wait for :3000.
#   4. docker build the derived image (cheap if cached).
#   5. docker run Playwright against PLAYWRIGHT_BASE_URL=http://host.docker.internal:3000.
#      The -v /work/node_modules anonymous volume MASKS the host darwin
#      node_modules with the image's linux node_modules — without it the
#      bind-mount overwrites the linux modules and @prisma/client+sharp blow up.
#   6. Forward $@ to `playwright test` so --update-snapshots works.
#
# Usage:
#   pnpm test:visual:local                # check against baselines
#   pnpm test:visual:update               # regenerate baselines
set -euo pipefail

cd "$(dirname "$0")/../.."

# Why the LAN IP (not host.docker.internal): the host dev server's Auth.js
# fetches discovery server-to-server against AUTH_OIDC_ISSUER. macOS resolves
# `host.docker.internal` ONLY from inside containers — from the host it ENOTFOUND-s,
# so the dev server's discovery fetch fails and every sign-in lands on
# /api/auth/error?error=Configuration. A LAN IP works from BOTH ends: the host
# uses its own IP, and the container reaches it via Docker Desktop's host-gateway
# (LAN routing). No /etc/hosts edit required.
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  echo "error: could not detect a LAN IP (en0/en1). Run with an active network interface." >&2
  exit 1
fi
echo "using LAN IP: $LAN_IP (so dev server + container browser see the same URLs)"

export E2E_AUTH_HOST="$LAN_IP"
# Tell Next 16 dev mode to accept /_next/* requests from the LAN-IP origin.
# Without this, JS bundles + HMR are blocked → React doesn't hydrate → forms
# fall back to plain HTML GET (RHF/server-action submits silently broken).
export NEXT_ALLOWED_DEV_ORIGIN="$LAN_IP"
# shellcheck disable=SC1091
source tests/e2e/_env-local.sh

# 1) DB migrations + category seed (global-setup did this; the dockerized run
# bypasses globalSetup, so we do it host-side).
pnpm exec prisma migrate deploy
pnpm exec tsx --env-file=.env prisma/seed.ts

# Track background PIDs so the trap can clean them up on any exit path.
MOCK_PID=""
WORKER_PID=""
DEV_PID=""
cleanup() {
  for pid in "$DEV_PID" "$WORKER_PID" "$MOCK_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

# 2) Mock-OIDC host launcher (mirrors what global-setup.ts does in-process).
pnpm exec tsx tests/e2e/start-mock-oidc.ts &
MOCK_PID=$!

# 3) pg-boss worker (mirrors global-setup.ts). The ~2s wait lets it register
# its handlers before specs start enqueueing search.index jobs.
pnpm exec tsx --env-file=.env worker/index.ts &
WORKER_PID=$!
sleep 2

# 4) Next dev server.
pnpm dev &
DEV_PID=$!

# Wait for :3000 to come up (cold-compile can take a while on first hit).
echo "waiting for dev server on :3000..."
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost:3000; then
    echo "dev server ready (${i}s)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "error: dev server didn't come up within 120s" >&2
    exit 1
  fi
  sleep 2
done

# 5) Build the derived image. Cheap if the lockfile + prisma schema haven't
# changed (docker layer cache wins). Tag is local-only.
docker build -f tests/e2e/visual.Dockerfile -t hm-visual .

# 6) Run Playwright inside the container against the host stack.
# Same LAN-IP rationale as above: the container reaches the host's Postgres/
# Meili/dev-server at $LAN_IP, which the host ALSO recognizes as itself, so
# AUTH_OIDC_ISSUER/AUTH_URL match exactly across both ends (no `iss` mismatch).
CONTAINER_DB_URL="$(echo "$DATABASE_URL" | sed -E "s#@([^:/]+)#@${LAN_IP}#")"
CONTAINER_MEILI_HOST="$(echo "$MEILI_HOST" | sed -E "s#//([^:/]+)#//${LAN_IP}#")"

docker run --rm \
  -v "$PWD":/work \
  -v /work/node_modules \
  -e PLAYWRIGHT_BASE_URL="http://${LAN_IP}:3000" \
  -e DATABASE_URL="$CONTAINER_DB_URL" \
  -e MEILI_HOST="$CONTAINER_MEILI_HOST" \
  -e MEILI_KEY="$MEILI_KEY" \
  -e AUTH_SECRET="$AUTH_SECRET" \
  -e AUTH_URL="$AUTH_URL" \
  -e AUTH_OIDC_ISSUER="$AUTH_OIDC_ISSUER" \
  -e AUTH_OIDC_CLIENT_ID="$AUTH_OIDC_CLIENT_ID" \
  -e AUTH_OIDC_CLIENT_SECRET="$AUTH_OIDC_CLIENT_SECRET" \
  -e MOCK_OIDC_ISSUER="$MOCK_OIDC_ISSUER" \
  hm-visual pnpm exec playwright test tests/e2e/visual.spec.ts "$@"
