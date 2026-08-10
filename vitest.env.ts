import { loadEnv } from 'vite';

/**
 * `.env` values for test workers, for the vars a test doesn't supply itself.
 *
 * Vitest inherits `process.env` from the shell, but nothing ever loaded `.env`
 * into it: Vite reads `.env` only into `import.meta.env`, and only for
 * `VITE_`-prefixed keys. Every other entry point in this repo loads it
 * explicitly — Next.js natively, `tsx --env-file=.env` for the seed script,
 * `tests/e2e/_env-local.sh` for Playwright — which left Vitest as the one
 * runner where `getEnv()` throws on AUTH_SECRET / AUTH_OIDC_* / MEILI_* even
 * on a fully configured machine. That is why every integration test touching a
 * `getEnv()` consumer has to `vi.mock('@/lib/env')` first, and why live-path
 * verification (a real Voyage call, a real email compose) wasn't available
 * locally at all.
 *
 * `loadEnv` with an empty prefix is Vite's documented escape hatch from the
 * `VITE_` filter. It reads `.env`, `.env.local`, `.env.{mode}` and
 * `.env.{mode}.local`; `mode` is `test` under Vitest, so a `.env.test` can
 * override `.env` per-machine without being checked in.
 *
 * Two properties this must keep:
 *
 *   - **The shell wins.** Anything already exported is filtered out rather
 *     than overwritten, because `test.env` otherwise takes precedence over the
 *     inherited environment. That covers CI's job env, a one-off
 *     `DATABASE_URL=… pnpm exec vitest`, and — the sharp one — `NODE_ENV`,
 *     which this repo's `.env` sets to `development` and which Vitest has
 *     already set to `test` by the time the config is evaluated.
 *   - **CI is unaffected.** There is no `.env` in CI, so `loadEnv` returns an
 *     empty object and this collapses to a no-op.
 *
 * Integration tests still point `DATABASE_URL` and `MEILI_HOST` at their
 * Testcontainers instances in `setupIntegration()`, which runs later and
 * assigns `process.env` directly.
 *
 * `envDir` exists only so the unit test can point this at a fixture directory.
 * CI has no `.env`, so a test that needs a real one can never run there — which
 * left the whole mechanism unguarded on the only machine where a regression
 * would be caught before merge. Production callers pass nothing.
 */
export function dotenvFallbacks(
  mode: string,
  envDir: string = process.cwd(),
): Record<string, string> {
  const fromFiles = loadEnv(mode, envDir, '');
  return Object.fromEntries(
    Object.entries(fromFiles).filter(([key]) => process.env[key] === undefined),
  );
}
