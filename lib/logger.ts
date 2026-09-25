import pino, { type Logger, type LoggerOptions } from 'pino';
import { deepScrubStrings, scrubSecrets } from './log-scrub';
import { PINO_ERROR_LEVEL, reportLoggedError } from './observability/error-reporter';

// Singleton Pino logger for the entire app.
//
// Usage:
//   import { getLogger } from '@/lib/logger';
//   const log = getLogger('ai.suggest.reminders');
//   log.info({ event: 'thing.happened', userId }, 'message');
//
// Levels: fatal | error | warn | info | debug | trace
// Default level: info in prod, debug in dev. Override via LOG_LEVEL env var.
//
// Output: JSON to stdout. Docker captures it; later, Promtail can ship to Loki.
// In dev, pipe through `pnpm exec pino-pretty` for human-readable colors.
//
// Redaction + scrubbing: redact paths blank known sensitive KEYS; the log-scrub
// pattern scrubber masks secrets embedded in string VALUES. See the loggerOptions
// comment below. Add new sensitive key names to the redact paths as they appear.

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

/**
 * The message pino will derive when the call passes no message of its own:
 * `logger.error({ err })` or `logger.error(err)`. pino fills `msg` from
 * `err.message` in `write()` (proto.js) for ANY truthy `err`, Error or not,
 * AFTER hooks.logMethod and outside formatters.log, so without this the one
 * secret-bearing string that skips every scrubbing layer is the log line's
 * `msg`. Mirrors pino's rule (an explicit `msg` in the merge object wins), and
 * only ever returns a string: a non-string `message` is left to pino, because
 * scrubSecrets on it would throw, and a log call must never throw.
 */
function derivedErrorMessage(args: readonly unknown[]): string | undefined {
  if (args.length !== 1) return undefined;
  const [first] = args;
  let message: unknown;
  if (first instanceof Error) {
    message = first.message;
  } else if (first !== null && typeof first === 'object') {
    const { msg, err } = first as { msg?: unknown; err?: unknown };
    if (msg === undefined && err) message = (err as { message?: unknown }).message;
  }
  return typeof message === 'string' ? message : undefined;
}

// Defense in depth, two layers:
//  1. `redact` blanks whole fields by key (fast, exact) — known sensitive keys.
//  2. pattern scrubbing (log-scrub) masks secrets EMBEDDED in string values —
//     DB connection strings, tokens, API keys — which redact can't reach. This
//     is the layer that catches leaks like a credential inside an Error's
//     `spawnargs`/`cmd`. Applied via the `err` serializer (the main leak vector),
//     `formatters.log` (any other object field), and `hooks.logMethod` (the
//     message string + interpolation args).
export const loggerOptions: LoggerOptions = {
  level,
  redact: {
    // Each sensitive key is listed both top-level and one-level-nested (`*.key`)
    // — pino's `*` wildcard is single-level, so `*.password` alone misses a
    // top-level `password`. The pattern scrubber (log-scrub) is the backstop for
    // deeper nesting and for secrets embedded inside string values.
    paths: [
      'apiKey',
      '*.apiKey',
      'token',
      '*.token',
      'secret',
      '*.secret',
      'password',
      '*.password',
      'databaseUrl',
      '*.databaseUrl',
      'connectionString',
      '*.connectionString',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'sessionToken',
      '*.sessionToken',
      'DATABASE_URL',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[Redacted]',
  },
  serializers: {
    // pino runs formatters.log BEFORE serializers, so by the time this sees
    // `err` it is usually already the plain { type, message, stack, ... } that
    // deepScrubStrings makes of an Error. Not pino.stdSerializers.err: given
    // that plain object it would relabel `type` as 'Object'. deepScrubStrings
    // serializes a raw Error the same way, so both paths agree.
    err: (e: unknown) => deepScrubStrings(e),
  },
  formatters: {
    // Catch-all: scrub embedded secrets from every string in the log object.
    log: (obj: Record<string, unknown>) => deepScrubStrings(obj) as Record<string, unknown>,
  },
  hooks: {
    // Scrub string arguments (the message + any %s interpolation values) before
    // pino formats them — formatters.log only sees the merge object, not the msg.
    // Then hand error/fatal calls to the Sentry bridge (a no-op unless an SDK
    // registered a reporter; see lib/observability/error-reporter.ts). It gets
    // the RAW args because it needs the Error object itself; scrubbing what
    // reaches Sentry is the SDK's beforeSend.
    logMethod(args, method, level) {
      const scrubbed = args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a));
      // No message given: supply the scrubbed err.message so pino doesn't
      // derive an unscrubbed one (see derivedErrorMessage).
      const derived = derivedErrorMessage(args);
      if (derived !== undefined) scrubbed.push(scrubSecrets(derived));
      method.apply(this, scrubbed as typeof args);
      // Level check first: bindings() re-parses the child's bindings, and
      // this hook runs on every enabled log call.
      if (level >= PINO_ERROR_LEVEL) reportLoggedError(args, level, this.bindings());
    },
  },
  // Don't add transports here — Next.js bundling fights worker_threads.
  // The dev-time pretty pipe is `pnpm dev | pnpm exec pino-pretty`.
};

export const logger: Logger = pino(loggerOptions);

export function getLogger(module: string): Logger {
  return logger.child({ module });
}
