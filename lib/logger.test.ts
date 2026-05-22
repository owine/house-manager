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
