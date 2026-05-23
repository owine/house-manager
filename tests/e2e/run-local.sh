#!/usr/bin/env bash
# Run the E2E suite locally with CI-equivalent env overrides.
#
# Local .env points OIDC at real Authelia, but E2E needs the mock OIDC server
# that global-setup.ts spins up on port 9999. This wrapper:
#   1. Sources tests/e2e/_env-local.sh, which pulls connection-y values from
#      .env (DATABASE_URL, MEILI_*, AUTH_SECRET) and stubs the env vars
#      lib/env.ts requires (push / email / anthropic / voyage). Shared with
#      run-visual.sh so the two harnesses can't drift.
#   2. Seeds categories (idempotent) so the harness's category combobox is
#      populated, matching CI's separate db:seed step.
#   3. Forwards any args to `playwright test`.
#
# Usage:
#   pnpm test:e2e:local                            # full suite
#   pnpm test:e2e:local tests/e2e/signin.spec.ts   # single spec
set -euo pipefail

cd "$(dirname "$0")/../.."

# E2E_AUTH_HOST defaults to "localhost" in the env script — leave it.
# shellcheck disable=SC1091
source tests/e2e/_env-local.sh

# Seed categories (CI runs db:seed separately; the harness's category combobox
# is empty otherwise). Idempotent upsert.
pnpm exec tsx --env-file=.env prisma/seed.ts

exec pnpm exec playwright test "$@"
