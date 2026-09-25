import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

// Headers for every response. None clashes with a route's own header except
// X-Content-Type-Options on /api/files, where both values are `nosniff`.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // No Strict-Transport-Security here, deliberately: prod sits behind
  // Cloudflare, which already sends `max-age=63072000` on every response
  // (checked 2026-09-24). A second HSTS header from the origin would hand the
  // browser two conflicting max-age values. HSTS belongs to whoever terminates
  // TLS; change it at the edge.
];

// Anti-framing for pages. Scoped AWAY from /api/files/: Next applies these
// before a route handler runs and then DROPS any handler header with the same
// name (node_modules/next/dist/server/send-response.js), so a global
// Content-Security-Policy here would replace the file route's sandbox CSP
// (lib/attachments/serve.ts) outright. Files need no framing protection: a
// sandboxed download or image has nothing to clickjack.
//
// No script-src CSP, deliberately: with RSC it needs per-request nonces from
// a proxy.ts, and a proxy.ts truncates request bodies over 10 MB
// (proxyClientMaxBodySize), which would break HMAC on large inbound emails.
const FRAME_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

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
  // Don't advertise the framework on every response.
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      // Everything except /api/files/<id>. Pattern checked with Next's own
      // matcher: matches /, /items/x, /api/health, /_next/...; not /api/files/x.
      { source: '/((?!api/files/).*)', headers: FRAME_HEADERS },
    ];
  },
};

// Source-map upload only. Every option here is build-time; runtime init lives
// in instrumentation.ts / instrumentation-client.ts / worker/sentry.ts.
//
// Imported from '@sentry/nextjs/config': the bare '@sentry/nextjs' import is
// deprecated in 10.x and removed in 11.
//
// Upload runs only when SENTRY_AUTH_TOKEN is present (CI passes it as a
// buildkit secret on main, see Dockerfile). Without it the plugin skips the
// upload and the build is unaffected. Under Turbopack the SDK turns on
// productionBrowserSourceMaps itself and deletes the maps after the upload
// step, token or not, so no .map file ships in the image either way.
//
// CI passes the identifiers as build-args from repo variables, which arrive
// as EMPTY strings when a variable is not configured. Delete those here, in
// the process that later spawns sentry-cli: an empty SENTRY_URL is not
// "unset" to it.
for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_URL']) {
  if (process.env[key] === '') delete process.env[key];
}

export default withSentryConfig(nextConfig, {
  silent: true,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // GlitchTip / self-hosted Sentry base URL. Unset means sentry.io.
  sentryUrl: process.env.SENTRY_URL,
  // The same 7-char release the runtime SDKs report (lib/version.ts), so
  // uploaded maps and events line up. NEXT_PUBLIC_GIT_SHA is the Docker
  // build-arg; there is no .git in the build context to derive it from.
  release: { name: (process.env.NEXT_PUBLIC_GIT_SHA ?? 'dev').slice(0, 7) },
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Don't send the bundler plugin's own usage telemetry to sentry.io.
  telemetry: false,
  // `webpack.treeshake.removeDebugLogging` was here. It is webpack-only and a
  // no-op under Turbopack (`next build`'s default), so it was dropped rather
  // than carried as dead config.
});
