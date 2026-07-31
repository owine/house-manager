import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the `test.env` wiring in vitest.config.ts.
 *
 * Vitest inherits the shell but does not read `.env` on its own — Vite loads
 * it only into `import.meta.env`, and only for `VITE_`-prefixed keys. Without
 * the `loadEnv` call in the config, `getEnv()` throws inside a worker on a
 * fully configured machine, which is why every integration test touching a
 * `getEnv()` consumer has to mock `@/lib/env` first.
 *
 * Skipped when there is no `.env` — that is CI, where the job environment
 * supplies what it needs and `loadEnv` correctly returns nothing.
 */
const hasDotenv = existsSync('.env');

function dotenvKeys(): string[] {
  return readFileSync('.env', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter((key): key is string => Boolean(key));
}

describe('vitest env loading', () => {
  it.skipIf(!hasDotenv)('exposes every .env key to test workers via process.env', () => {
    const missing = dotenvKeys().filter((key) => process.env[key] === undefined);
    expect(missing).toEqual([]);
  });

  // The shell has to win over the file, or a `.env` carrying
  // `NODE_ENV=development` (this repo's does) would silently flip every test
  // run into development mode — Vitest sets NODE_ENV before the config is
  // evaluated, so the filter in vitest.config.ts drops it.
  it('does not let .env override a variable the runner already set', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it.skipIf(!hasDotenv)(
    'lets a real getEnv() consumer run without stubbing @/lib/env',
    async () => {
      const { getEnv } = await import('@/lib/env');
      expect(() => getEnv()).not.toThrow();
    },
  );
});
