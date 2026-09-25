import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loggerOptions } from '@/lib/logger';
import {
  type ErrorReporter,
  getErrorReporter,
  sentryReporter,
  setErrorReporter,
} from './error-reporter';

/** A logger with the app's real options (hooks included) writing to memory. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const root = pino(
    { ...loggerOptions, level: 'trace' },
    { write: (s: string) => lines.push(JSON.parse(s)) },
  );
  return { log: root.child({ module: 'test.bridge' }), lines };
}

function installSpy() {
  const reporter = vi.fn<ErrorReporter>();
  setErrorReporter(reporter);
  return reporter;
}

// Built from parts so no credentialed URL appears literally in the source.
const DB_USER = 'housemanager';
const DB_PW = 's3cr3tP%40ss';
const DB_URL = `postgresql://${DB_USER}:${DB_PW}@db-host:5432/housemanager`;
const MASKED_DB_URL = DB_URL.replace(DB_PW, '***');

afterEach(() => setErrorReporter(undefined));

describe('Pino -> Sentry bridge', () => {
  it('reports logger.error({ err }) once, with module, event and the message', () => {
    const reporter = installSpy();
    const { log } = captureLogger();
    const err = new Error('voyage 400');

    log.error({ err, event: 'embed.failed', entityId: 'n1' }, 'embed-content: failed');

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(err, {
      level: 'error',
      module: 'test.bridge',
      event: 'embed.failed',
      message: 'embed-content: failed',
    });
  });

  it('reports an Error passed as the first argument, and fatal as fatal', () => {
    const reporter = installSpy();
    const { log } = captureLogger();
    const err = new Error('boot failed');

    log.fatal(err, 'worker failed to start');

    expect(reporter).toHaveBeenCalledWith(err, expect.objectContaining({ level: 'fatal' }));
  });

  // pg-dump logs safe fields at error level AND captures the Error itself.
  // Reporting error lines without an Error would double-report it as a
  // message-only event. Mutation-checked: a captureMessage-style fallback for
  // err-less lines fails this test.
  it('ignores error lines that carry no Error', () => {
    const reporter = installSpy();
    const { log } = captureLogger();

    log.error({ event: 'pg-dump.failed', code: 1, stderr: 'refused' }, 'pg_dump failed');
    log.error({ err: 'a string, not an Error' }, 'odd');
    log.error('plain message');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('ignores warn and below, even with an Error', () => {
    const reporter = installSpy();
    const { log } = captureLogger();

    log.warn({ err: new Error('retryable') }, 'will retry');
    log.info({ err: new Error('x') }, 'x');

    expect(reporter).not.toHaveBeenCalled();
  });

  // Call sites that already did Sentry.captureException(err) and then log the
  // same err must not produce a second event. The SDK marks captured errors;
  // the bridge honours the mark. Mutation-checked: dropping alreadyCaptured()
  // fails this test (the real-SDK test in sentry-bridge.test.ts pins the flag).
  it('does not re-report an Error Sentry already captured', () => {
    const reporter = installSpy();
    const { log } = captureLogger();
    const err = new Error('pg-boss error');
    Object.defineProperty(err, '__sentry_captured__', { value: true, enumerable: false });

    log.error({ err }, 'pg-boss error');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('scrubs the message it forwards; the Error goes to the SDK for beforeSend', () => {
    const reporter = installSpy();
    const { log } = captureLogger();

    log.error({ err: new Error('x') }, `cannot reach ${DB_URL}`);

    expect(reporter.mock.calls[0][1].message).toBe(`cannot reach ${MASKED_DB_URL}`);
  });

  it('is a no-op without a reporter (no DSN): logging still works', () => {
    expect(getErrorReporter()).toBeUndefined();
    const { log, lines } = captureLogger();
    expect(() => log.error({ err: new Error('x') }, 'no sentry')).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('a throwing reporter never breaks logging', () => {
    setErrorReporter(() => {
      throw new Error('transport down');
    });
    const { log, lines } = captureLogger();
    expect(() => log.error({ err: new Error('x') }, 'still logged')).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('does not recurse when the reporter itself logs an error', () => {
    const { log } = captureLogger();
    const reporter = vi.fn<ErrorReporter>(() => {
      log.error({ err: new Error('inner') }, 'reporter logged');
    });
    setErrorReporter(reporter);

    log.error({ err: new Error('outer') }, 'outer');

    expect(reporter).toHaveBeenCalledTimes(1);
  });
});

describe('sentryReporter', () => {
  it('maps a report to captureException tags and extra', () => {
    const capture = vi.fn();
    const err = new Error('x');
    sentryReporter(capture)(err, {
      level: 'fatal',
      module: 'worker.lifecycle',
      event: 'startup.failed',
      message: 'failed to start',
    });
    expect(capture).toHaveBeenCalledWith(err, {
      level: 'fatal',
      tags: { source: 'pino', module: 'worker.lifecycle', event: 'startup.failed' },
      extra: { logMessage: 'failed to start' },
    });
  });

  it('omits absent fields rather than sending undefined', () => {
    const capture = vi.fn();
    sentryReporter(capture)(new Error('x'), { level: 'error' });
    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      level: 'error',
      tags: { source: 'pino' },
      extra: {},
    });
  });
});
