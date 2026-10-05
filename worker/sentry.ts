import * as Sentry from '@sentry/node';
import { sentryReporter, setErrorReporter } from '@/lib/observability/error-reporter';
import { sentryOptions } from '@/lib/observability/sentry-options';

/**
 * Worker-side Sentry: init with the shared options, then register the Pino
 * bridge so `logger.error({ err })` anywhere in the worker reaches Sentry.
 * No DSN means neither happens and every capture is a no-op.
 *
 * Must run before main() calls getBoss(): lib/queue.ts's boss.on('error')
 * reports through this client. Where the import line sits does not matter
 * (ESM evaluates every import before the importing module's body); where
 * this CALL sits does.
 */
export function initWorkerSentry(
  dsn: string | undefined = process.env.SENTRY_DSN,
  /** Test seam (a fake transport). The worker passes nothing. */
  overrides: Sentry.NodeOptions = {},
): boolean {
  if (!dsn) return false;
  Sentry.init({
    ...sentryOptions(dsn),
    // A set maxRequestBodySize wins over dataCollection.httpBodies, so this
    // pins incoming body capture off even if httpBodies is ever loosened. The
    // worker's only server is its health endpoint; this keeps both server
    // inits identical.
    integrations: [Sentry.httpIntegration({ maxRequestBodySize: 'none' })],
    ...overrides,
  });
  setErrorReporter(sentryReporter(Sentry.captureException));
  return true;
}

/**
 * Send whatever is queued before the process exits. `captureException` only
 * queues; a `process.exit(1)` straight after it loses the event, and the
 * startup-failure event is the one that matters most. Bounded, never throws.
 */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  await Sentry.flush(timeoutMs).catch(() => false);
}
