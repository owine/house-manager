import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits .next/standalone: a self-contained server.js plus a file-traced
  // node_modules holding only what the app actually imports. The Dockerfile
  // copies that to /app/web, which is what lets /app/node_modules be pruned
  // to the worker's closure in a follow-up.
  output: 'standalone',
  // Next 16.3.1 bumped @swc/helpers 0.5.15 -> 0.5.23, which added a
  // `module-sync` condition to every `./_/*` subpath export:
  //
  //   "./_/_interop_require_default": {
  //     "module-sync": "./esm/_interop_require_default.js",   // <- new in 0.5.23
  //     "import":      "./esm/_interop_require_default.js",
  //     "default":     "./cjs/_interop_require_default.cjs"
  //   }
  //
  // next/dist requires `@swc/helpers/_/_interop_require_default` from ~57
  // places. Node 22.10+/24 honours `module-sync` from CJS `require()`, so at
  // runtime that now resolves to the ESM file — but the file tracer still only
  // copies the `cjs/` one into .next/standalone. The bundle then has a
  // @swc/helpers whose package.json resolves a subpath to a file that isn't
  // there, and web dies at boot with `createEsmNotFoundErr`:
  //
  //   Cannot find module '/app/web/node_modules/.pnpm/next@16.3.1_.../
  //     node_modules/@swc/helpers/esm/_interop_require_default.js'
  //
  // Nothing but the image catches this: typecheck, `next build`, and every
  // vitest/playwright suite resolve against the full source tree. It was
  // scripts/smoke-image.sh that caught it. Upstream: vercel/next.js#97358,
  // fixed by #97372 but only on canary — 16.3.1 is still the latest stable, so
  // this stays until a release carries the fix, then it can go.
  outputFileTracingIncludes: {
    '/*': ['./node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/**/*'],
  },
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
