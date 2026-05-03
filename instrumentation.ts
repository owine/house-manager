// Next.js Server-side observability bootstrap. Loaded by Next.js's
// instrumentation hook on every server / edge runtime startup.
//
// Sentry init is gated on SENTRY_DSN being set. With no DSN, register()
// does nothing — the SDK isn't even loaded into the bundle's hot path.
//
// Release tag and environment come from the existing version module so
// stack traces in Sentry/GlitchTip line up with the deployed git SHA
// (see lib/version.ts).

export async function register() {
  if (!process.env.SENTRY_DSN) return;

  const { APP_GIT_SHA } = await import('@/lib/version');

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: APP_GIT_SHA,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: APP_GIT_SHA,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  }
}
