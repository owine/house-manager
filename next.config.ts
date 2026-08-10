import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
    // Next 16.3 flipped `useTypeScriptCli` to default `true`, which switches the
    // TypeScript dependency check from `typescript/lib/typescript.js` (the JS API)
    // to the `typescript/bin/tsc` binary. Our `typescript` entry is aliased to the
    // TS 6 API shim (`@typescript/typescript6`), which ships `bin/tsc6` — not
    // `bin/tsc` — so the CLI path reports TypeScript as missing and `next dev`
    // dies before the server is reachable (e2e/a11y then time out on webServer).
    // The `tsc` binary in this repo comes from `@typescript/native` (TS 7) and is
    // driven by `pnpm typecheck`, not by Next. See CLAUDE.md § "Do not collapse
    // the TypeScript 6/7 aliases". Drop this once Next supports TS 7 natively and
    // the aliases go away.
    useTypeScriptCli: false,
  },
  // Allow the local visual-test harness (tests/e2e/run-visual.sh) to access the
  // dev server via the host's LAN IP. Without this, Next 16 blocks cross-origin
  // /_next/* asset requests in dev → JS bundle doesn't load → React doesn't
  // hydrate → forms fall back to plain HTML GET (RHF/server actions broken).
  // Unset in normal `pnpm dev`, so this is a no-op for everyone else.
  allowedDevOrigins: process.env.NEXT_ALLOWED_DEV_ORIGIN
    ? [process.env.NEXT_ALLOWED_DEV_ORIGIN]
    : undefined,
};

export default withSentryConfig(nextConfig, {
  // Sentry build-time options — used only for source-map upload.
  // Skipped automatically when SENTRY_AUTH_TOKEN is unset.
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Don't serve source maps to clients — Sentry only needs them uploaded.
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Tree-shake the SDK's debug logger out of the bundle. Replaces the
  // deprecated top-level `disableLogger: true` (the old key still works
  // but warns on every build).
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
