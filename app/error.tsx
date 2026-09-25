'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

// Segment error boundary. Reports errors thrown in the browser; a no-op when
// the browser SDK was not initialised (no SENTRY_BROWSER_DSN).
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A digest means the error was thrown on the server, where onRequestError
    // (instrumentation.ts) already reported the original. The browser only
    // has a redacted copy; reporting it too would double every server error.
    if (!error.digest) Sentry.captureException(error);
  }, [error]);

  return (
    <div>
      <h1>Something went wrong</h1>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
