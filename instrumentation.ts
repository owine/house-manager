import type { Instrumentation } from 'next';

// Next.js server-side observability bootstrap. `register` runs once per server
// runtime (nodejs, edge) at startup; `onRequestError` is Next's hook for every
// error thrown while serving a request: Server Components, route handlers,
// server actions. Under Turbopack (the default `next build` in Next 16) there
// are no webpack wrapping loaders, so onRequestError is the ONLY path by which
// those errors reach Sentry.
//
// Everything is gated on SENTRY_DSN. With no DSN, register() returns before
// loading the SDK and onRequestError returns before touching it.
//
// Release and environment come from lib/observability/sentry-options.ts,
// shared with the browser and worker inits.

export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (process.env.NEXT_RUNTIME !== 'nodejs' && process.env.NEXT_RUNTIME !== 'edge') return;

  const Sentry = await import('@sentry/nextjs');
  const { sentryOptions } = await import('@/lib/observability/sentry-options');
  Sentry.init({
    ...sentryOptions(dsn),
    // nodejs only (the edge SDK has no HTTP server integration). In 10.75 it
    // buffers incoming request bodies onto the scope unless told not to,
    // whatever dataCollection.httpBodies says; scrubEvent also drops
    // `request.data`, so this is belt and braces. (11 renames the option and
    // gates it on dataCollection; tsc will flag this line on that bump.)
    // Passing our own httpIntegration REPLACES @sentry/nextjs's default, which
    // sets disableIncomingRequestSpans (server/index.js): Next creates its own
    // request spans, and without this every request gets a second root span.
    ...(process.env.NEXT_RUNTIME === 'nodejs' && {
      integrations: [
        Sentry.httpIntegration({
          maxIncomingRequestBodySize: 'none',
          disableIncomingRequestSpans: true,
        }),
      ],
    }),
  });

  // Pino only runs in the nodejs runtime, so the bridge is registered there.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { sentryReporter, setErrorReporter } = await import('@/lib/observability/error-reporter');
    setErrorReporter(sentryReporter(Sentry.captureException));
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (!process.env.SENTRY_DSN) return;
  const { captureRequestError } = await import('@sentry/nextjs');
  captureRequestError(err, request, context);
};
