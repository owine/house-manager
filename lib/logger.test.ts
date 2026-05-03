import { describe, expect, it } from 'vitest';
import { getLogger, logger } from './logger';

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
