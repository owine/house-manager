import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits .next/standalone: a self-contained server.js plus a file-traced
  // node_modules holding only what the app actually imports. The Dockerfile
  // copies that to /app/web, which is what lets /app/node_modules be pruned
  // to the worker's closure in a follow-up.
  output: 'standalone',
  // See tsconfig.build.json — keeps `next build`'s CLI type-checker off test
  // files, which aren't in the Docker build context.
  typescript: {
    tsconfigPath: 'tsconfig.build.json',
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
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
