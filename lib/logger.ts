import pino, { type Logger, type LoggerOptions } from 'pino';
import { deepScrubStrings, scrubSecrets } from './log-scrub';

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
    // Serialize the Error the standard way, then scrub embedded secrets from the
    // resulting strings (message, stack, and custom props like cmd/spawnargs).
    err: (e: unknown) => deepScrubStrings(pino.stdSerializers.err(e as Error)),
  },
  formatters: {
    // Catch-all: scrub embedded secrets from every string in the log object.
    log: (obj: Record<string, unknown>) => deepScrubStrings(obj) as Record<string, unknown>,
  },
  hooks: {
    // Scrub string arguments (the message + any %s interpolation values) before
    // pino formats them — formatters.log only sees the merge object, not the msg.
    logMethod(args, method) {
      const scrubbed = args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a));
      return method.apply(this, scrubbed as typeof args);
    },
  },
  // Don't add transports here — Next.js bundling fights worker_threads.
  // The dev-time pretty pipe is `pnpm dev | pnpm exec pino-pretty`.
};

export const logger: Logger = pino(loggerOptions);

export function getLogger(module: string): Logger {
  return logger.child({ module });
}
