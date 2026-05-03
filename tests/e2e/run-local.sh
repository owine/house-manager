#!/usr/bin/env bash
# Run the E2E suite locally with CI-equivalent env overrides.
#
# Local .env points OIDC at real Authelia, but E2E needs the mock OIDC server
# that global-setup.ts spins up on port 9999. This wrapper:
#   1. Pulls connection-y values (DATABASE_URL, MEILI_*, AUTH_SECRET) from .env
#      so we don't have to duplicate them.
#   2. Overrides the AUTH_OIDC_* + AUTH_URL vars to match the mock setup.
#   3. Stubs the env vars lib/env.ts requires (push, email, anthropic).
#   4. Forwards any args to `playwright test`.
#
# Usage:
#   pnpm test:e2e:local                       # full suite
#   pnpm test:e2e:local tests/e2e/signin.spec.ts   # single spec
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  echo "error: .env not found in repo root" >&2
  exit 1
fi

extract() { grep "^$1=" .env | cut -d= -f2-; }

DATABASE_URL=$(extract DATABASE_URL) \
MEILI_HOST=$(extract MEILI_HOST) \
MEILI_KEY=$(extract MEILI_KEY) \
AUTH_SECRET=$(extract AUTH_SECRET) \
AUTH_URL=http://localhost:3000 \
AUTH_OIDC_ISSUER=http://localhost:9999 \
AUTH_OIDC_CLIENT_ID=house-manager \
AUTH_OIDC_CLIENT_SECRET=test \
FILES_DIR=/tmp/files \
WEB_PUSH_VAPID_PUBLIC_KEY=fixture \
WEB_PUSH_VAPID_PRIVATE_KEY=fixture \
WEB_PUSH_CONTACT_EMAIL=mailto:ci@example.com \
FORWARDEMAIL_API_KEY=fixture \
FORWARDEMAIL_FROM_ADDRESS=ci@example.com \
ANTHROPIC_API_KEY=sk-ant-test-placeholder \
exec pnpm exec playwright test "$@"
