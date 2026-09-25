// Browser-side Sentry. Next.js runs this file before hydration on every full
// page load (node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation-client.md). It replaces
// sentry.client.config.ts, which only @sentry/nextjs's webpack path ever
// loaded; `next build` is Turbopack, so the browser SDK never started.
//
// The DSN is read at runtime from a <meta> the root layout renders from the
// server's SENTRY_BROWSER_DSN (lib/observability/browser-dsn.ts), not inlined
// at build time, so one image serves every deployment. No meta, no init.

import * as Sentry from '@sentry/nextjs';
import { BROWSER_DSN_META, sentryOptions } from '@/lib/observability/sentry-options';

function dsnMeta(): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${BROWSER_DSN_META}"]`)?.content;
}

function start(): void {
  const dsn = dsnMeta();
  if (dsn) Sentry.init(sentryOptions(dsn));
}

// Next's own async <script> tags precede the layout's <head> children, so in
// principle this can run before the parser reaches the meta. Fall back to
// DOMContentLoaded rather than silently staying off for the whole page.
if (dsnMeta() === undefined && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

// Navigation breadcrumbs. Harmless when the SDK was not initialised.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
