import pino, { type Logger } from 'pino';

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
// Redaction: the redact paths below blank known sensitive keys regardless of
// nesting depth. Add new paths here as new sensitive fields appear.

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

export const logger: Logger = pino({
  level,
  redact: {
    paths: [
      '*.apiKey',
      '*.token',
      '*.secret',
      '*.password',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[Redacted]',
  },
  // Don't add transports here — Next.js bundling fights worker_threads.
  // The dev-time pretty pipe is `pnpm dev | pnpm exec pino-pretty`.
});

export function getLogger(module: string): Logger {
  return logger.child({ module });
}
