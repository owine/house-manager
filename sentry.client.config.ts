// Browser-side Sentry init. Loaded by @sentry/nextjs's bundler integration.
// Same DSN-gate as the server side; if NEXT_PUBLIC_SENTRY_DSN is unset at
// build time, the browser bundle skips Sentry entirely.

import * as Sentry from '@sentry/nextjs';
import { APP_GIT_SHA } from '@/lib/version';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    release: APP_GIT_SHA,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}
