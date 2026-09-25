import { scrubSecrets } from '@/lib/log-scrub';

// The Pino -> Sentry bridge. lib/logger.ts calls reportLoggedError() for every
// error/fatal log call; if that call carries an Error (`{ err }` or an Error
// as the first argument) and an SDK has registered a reporter, the Error is
// reported once.
//
// This module imports no Sentry SDK. The worker (@sentry/node) and web
// (@sentry/nextjs) each register their own reporter at init (worker/sentry.ts,
// instrumentation.ts), so neither SDK leaks into the other's module graph and
// the worker image never needs @sentry/nextjs. No DSN, no init, no reporter:
// the bridge is then a no-op.
//
// The reporter lives on globalThis, not in a module variable. Next bundles
// instrumentation.ts separately from the route/page chunks, and a module-level
// variable set in one bundle's copy of this file is invisible to another's.

/** Pino's numeric level for `error`. `fatal` is 60. */
export const PINO_ERROR_LEVEL = 50;

type LoggedErrorReport = {
  level: 'error' | 'fatal';
  /** The child logger's `module` binding, e.g. `worker.embed-content`. */
  module?: string;
  /** The log call's `event` field, when it has one. */
  event?: string;
  /** The log message, scrubbed. */
  message?: string;
};

export type ErrorReporter = (err: Error, report: LoggedErrorReport) => void;

const REPORTER = Symbol.for('house-manager.error-reporter');
type Carrier = { [REPORTER]?: ErrorReporter };

export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  (globalThis as Carrier)[REPORTER] = reporter;
}

export function getErrorReporter(): ErrorReporter | undefined {
  return (globalThis as Carrier)[REPORTER];
}

/**
 * Sentry marks every exception it captures with this non-enumerable flag
 * (`checkOrSetAlreadyCaught` in @sentry/core, still present in 11.0.0). A
 * call site that already did `Sentry.captureException(err)` and then logs the
 * same `err` must not report it twice. The SDK would drop the duplicate on its
 * own; checking here keeps the bridge's contract independent of that.
 */
function alreadyCaptured(err: Error): boolean {
  return (err as { __sentry_captured__?: unknown }).__sentry_captured__ === true;
}

let reporting = false;

/**
 * Called from lib/logger.ts's `hooks.logMethod` with the raw (unscrubbed) log
 * arguments. The Error object is passed to the reporter as-is: scrubbing its
 * message and stack is the SDK's `beforeSend` job (lib/observability/
 * sentry-options.ts), which covers every event, not just bridged ones.
 *
 * Never throws: a broken reporter must not break logging.
 */
export function reportLoggedError(
  args: readonly unknown[],
  level: number,
  bindings: Record<string, unknown>,
): void {
  if (level < PINO_ERROR_LEVEL || reporting) return;
  const reporter = getErrorReporter();
  if (!reporter) return;

  const [first, second] = args;
  const merge =
    first !== null && typeof first === 'object' && !(first instanceof Error)
      ? (first as Record<string, unknown>)
      : undefined;
  const err = first instanceof Error ? first : merge?.err;
  // No Error, no report. An error-level line without one (pg-dump logs safe
  // fields and captures separately) would otherwise become a second, message-
  // only event.
  if (!(err instanceof Error) || alreadyCaptured(err)) return;

  const message = typeof second === 'string' ? scrubSecrets(second) : undefined;
  const report: LoggedErrorReport = {
    level: level >= 60 ? 'fatal' : 'error',
    ...(typeof bindings.module === 'string' && { module: bindings.module }),
    ...(typeof merge?.event === 'string' && { event: merge.event }),
    ...(message !== undefined && { message }),
  };

  reporting = true;
  try {
    reporter(err, report);
  } catch {
    // Reporting is best-effort; the log line has already been written.
  } finally {
    reporting = false;
  }
}

/**
 * The reporter both SDKs register. Takes the SDK's `captureException` so this
 * file stays SDK-free. Module and event become tags (searchable), the log
 * message goes to `extra`.
 */
export function sentryReporter(
  captureException: (
    err: unknown,
    context: {
      level: 'error' | 'fatal';
      tags: Record<string, string>;
      extra: Record<string, string>;
    },
  ) => unknown,
): ErrorReporter {
  return (err, report) => {
    const tags: Record<string, string> = { source: 'pino' };
    if (report.module) tags.module = report.module;
    if (report.event) tags.event = report.event;
    const extra: Record<string, string> = {};
    if (report.message) extra.logMessage = report.message;
    captureException(err, { level: report.level, tags, extra });
  };
}
