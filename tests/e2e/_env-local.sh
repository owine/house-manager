# Shared env block for the e2e + visual local harnesses (sourced, not exec).
#
# Both run-local.sh (host-only Playwright) and run-visual.sh (host services
# + dockerized Playwright) call this so the override matrix can't drift. It
# pulls connection-y values from .env and stubs the env vars lib/env.ts
# requires (push / email / anthropic / voyage) so the dev server boots
# without surprise prod credentials.
#
# Inputs (env vars):
#   E2E_AUTH_HOST  — host the container/browser uses to reach the dev server
#                    + mock-OIDC. Defaults to "localhost" (run-local.sh).
#                    run-visual.sh sets it to "host.docker.internal".
#
# Outputs (env vars exported in the caller's shell):
#   DATABASE_URL MEILI_HOST MEILI_KEY AUTH_SECRET
#   AUTH_URL AUTH_OIDC_ISSUER AUTH_OIDC_CLIENT_ID AUTH_OIDC_CLIENT_SECRET
#   MOCK_OIDC_ISSUER
#   FILES_DIR
#   WEB_PUSH_VAPID_PUBLIC_KEY WEB_PUSH_VAPID_PRIVATE_KEY WEB_PUSH_CONTACT_EMAIL
#   FORWARDEMAIL_API_KEY FORWARDEMAIL_FROM_ADDRESS
#   ANTHROPIC_API_KEY VOYAGE_API_KEY
#   ASK_ENABLED OCR_BACKEND

# shellcheck shell=bash

if [ ! -f .env ]; then
  echo "error: .env not found in repo root (cwd=$(pwd))" >&2
  return 1 2>/dev/null || exit 1
fi

# Read a single VAR=value line from .env (everything after the first '=').
_extract() { grep "^$1=" .env | cut -d= -f2-; }

E2E_AUTH_HOST="${E2E_AUTH_HOST:-localhost}"

export DATABASE_URL
DATABASE_URL=$(_extract DATABASE_URL)
export MEILI_HOST
MEILI_HOST=$(_extract MEILI_HOST)
export MEILI_KEY
MEILI_KEY=$(_extract MEILI_KEY)
export AUTH_SECRET
AUTH_SECRET=$(_extract AUTH_SECRET)

export AUTH_URL="http://${E2E_AUTH_HOST}:3000"
export AUTH_OIDC_ISSUER="http://${E2E_AUTH_HOST}:9999"
export AUTH_OIDC_CLIENT_ID="house-manager"
export AUTH_OIDC_CLIENT_SECRET="test"
# mock-oidc.ts emits this as the issuer + endpoint host in its discovery doc.
# Default in mock-oidc.ts is `http://localhost:${port}`, which is fine for
# run-local.sh; run-visual.sh must override to host.docker.internal so the
# container's auth.js can reach it.
export MOCK_OIDC_ISSUER="http://${E2E_AUTH_HOST}:9999"

export FILES_DIR="/tmp/files"
export WEB_PUSH_VAPID_PUBLIC_KEY="fixture"
export WEB_PUSH_VAPID_PRIVATE_KEY="fixture"
export WEB_PUSH_CONTACT_EMAIL="mailto:ci@example.com"
export FORWARDEMAIL_API_KEY="fixture"
export FORWARDEMAIL_FROM_ADDRESS="ci@example.com"
export ANTHROPIC_API_KEY="sk-ant-test-placeholder"
export VOYAGE_API_KEY="fixture"
export ASK_ENABLED="false"
export OCR_BACKEND="none"
