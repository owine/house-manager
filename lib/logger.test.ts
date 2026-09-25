import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { getLogger, logger, loggerOptions } from './logger';

/** Build a logger that writes JSON lines into `lines` so we can assert output. */
function captureLogger(): { log: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const sink = {
    write(s: string) {
      lines.push(JSON.parse(s));
    },
  };
  // Force trace so everything is emitted regardless of env LOG_LEVEL.
  const log = pino({ ...loggerOptions, level: 'trace' }, sink);
  return { log, lines };
}

const DB_URL = 'postgresql://housemanager:s3cr3tP%40ss@db-host:5432/housemanager';

describe('logger secret scrubbing', () => {
  it('scrubs a DB password embedded in an Error’s spawnargs', () => {
    const { log, lines } = captureLogger();
    const err = Object.assign(new Error(`pg_dump failed: ${DB_URL}`), {
      cmd: `pg_dump --dbname=${DB_URL}`,
      spawnargs: ['--format=custom', `--dbname=${DB_URL}`],
    });
    log.error({ err }, 'pg_dump failed');
    const out = JSON.stringify(lines[0]);
    expect(out).not.toContain('s3cr3tP%40ss');
    expect(out).toContain('postgresql://housemanager:***@');
  });

  it('scrubs a secret in the message string and in %s interpolation args', () => {
    const { log, lines } = captureLogger();
    log.info('connecting to %s', DB_URL);
    const out = JSON.stringify(lines[0]);
    expect(out).not.toContain('s3cr3tP%40ss');
    expect(out).toContain('***');
  });

  it('scrubs a secret embedded in an arbitrary object field', () => {
    const { log, lines } = captureLogger();
    log.info({ conn: DB_URL }, 'using connection');
    expect(JSON.stringify(lines[0])).not.toContain('s3cr3tP%40ss');
  });

  it('still blanks known sensitive keys via redact', () => {
    const { log, lines } = captureLogger();
    log.info({ password: 'plaintext', nested: { token: 'abc' } }, 'creds');
    const out = JSON.stringify(lines[0]);
    expect(out).toContain('[Redacted]');
    expect(out).not.toContain('plaintext');
    expect(out).not.toContain('abc');
  });
});

// Regression (#169, 2026-05-22 until this fix): formatters.log runs before the
// err serializer and flattened every Error to its enumerable fields, so every
// `{ err }` in production logs was `{}`. Mutation-checked: removing the
// `instanceof Error` branch in deepScrubStrings fails all three.
describe('logger error serialization', () => {
  it('keeps type, message and stack of an { err }', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new TypeError('fetch failed') }, 'ping failed');
    expect(lines[0].err).toMatchObject({ type: 'TypeError', message: 'fetch failed' });
    expect((lines[0].err as { stack?: string }).stack).toContain('TypeError: fetch failed');
  });

  it('keeps an Error passed as the first argument, and its cause and custom fields', () => {
    const { log, lines } = captureLogger();
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    log.error(new Error('outer', { cause }));
    expect(lines[0].msg).toBe('outer');
    expect(lines[0].err).toMatchObject({
      type: 'Error',
      message: 'outer',
      cause: { type: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    });
  });

  it('still scrubs secrets inside the message and stack', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error(`cannot reach ${DB_URL}`) }, 'db');
    const err = lines[0].err as { message: string; stack: string };
    expect(err.message).toBe(`cannot reach ${DB_URL.replace('s3cr3tP%40ss', '***')}`);
    expect(err.stack).not.toContain('s3cr3tP%40ss');
  });

  // The err serializer re-scrubs only the top-level `err`. Everything below is
  // scrubbed by deepScrubStrings walking the Error's fields in formatters.log.
  // Mutation-checked: returning errorFields(value) unscrubbed fails all three,
  // and dropping the aggregateErrors line fails the last.
  it('scrubs secrets in a cause, an Error under another key, and AggregateError members', () => {
    const { log, lines } = captureLogger();
    const masked = `cannot reach ${DB_URL.replace('s3cr3tP%40ss', '***')}`;
    log.error({ err: new Error('outer', { cause: new Error(`cannot reach ${DB_URL}`) }) }, 'a');
    log.error({ error: new Error(`cannot reach ${DB_URL}`) }, 'b');
    log.error({ err: new AggregateError([new Error(`cannot reach ${DB_URL}`)], 'many') }, 'c');

    expect(JSON.stringify(lines)).not.toContain('s3cr3tP%40ss');
    expect((lines[0].err as { cause: { message: string } }).cause.message).toBe(masked);
    expect((lines[1].error as { message: string }).message).toBe(masked);
    expect(
      (lines[2].err as { aggregateErrors: Array<{ message: string }> }).aggregateErrors[0].message,
    ).toBe(masked);
  });
});

// pino fills a missing message from err.message after every scrubbing layer.
// Mutation-checked: removing the derivedErrorMessage push fails the first test.
describe('logger message derived from an Error', () => {
  const MASKED = `cannot reach ${DB_URL.replace('s3cr3tP%40ss', '***')}`;

  it('scrubs the msg pino derives from err.message when no message is given', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error(`cannot reach ${DB_URL}`) });
    log.error(new Error(`cannot reach ${DB_URL}`));
    expect(lines.map((l) => l.msg)).toEqual([MASKED, MASKED]);
    expect(JSON.stringify(lines)).not.toContain('s3cr3tP%40ss');
  });

  // pino derives msg from ANY truthy err, not only an Error.
  it('scrubs the msg derived from a plain-object err', () => {
    const { log, lines } = captureLogger();
    log.error({ err: { message: `cannot reach ${DB_URL}` } });
    expect(lines[0].msg).toBe(MASKED);
    expect(JSON.stringify(lines)).not.toContain('s3cr3tP%40ss');
  });

  // Logging must never throw: scrubSecrets on a number would.
  it('does not throw, or derive a msg, when err.message is not a string', () => {
    const { log, lines } = captureLogger();
    const err = new Error('x');
    (err as { message: unknown }).message = 42;
    expect(() => log.error({ err })).not.toThrow();
    expect(() => log.error({ err: { message: { nested: true } } })).not.toThrow();
    expect(lines).toHaveLength(2);
  });

  it('leaves an explicit message, or a msg in the merge object, alone', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error('boom') }, 'explicit');
    log.error({ err: new Error('boom'), msg: 'from merge object' });
    expect(lines.map((l) => l.msg)).toEqual(['explicit', 'from merge object']);
  });
});

describe('logger', () => {
  it('exports a singleton Pino-shaped logger', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('getLogger returns a child with the module field bound', () => {
    const child = getLogger('test.module');
    expect(typeof child.info).toBe('function');
    expect(child.bindings()).toMatchObject({ module: 'test.module' });
  });

  it('does not throw when calling each level', () => {
    const child = getLogger('test.level');
    expect(() => child.debug({ x: 1 }, 'debug')).not.toThrow();
    expect(() => child.info({ x: 1 }, 'info')).not.toThrow();
    expect(() => child.warn({ x: 1 }, 'warn')).not.toThrow();
    expect(() => child.error({ x: 1 }, 'error')).not.toThrow();
  });
});
