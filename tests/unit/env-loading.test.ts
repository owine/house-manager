import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotenvFallbacks } from '../../vitest.env';

/**
 * Guards the `test.env` wiring in vitest.config.ts.
 *
 * Vitest inherits the shell but does not read `.env` on its own — Vite loads
 * it only into `import.meta.env`, and only for `VITE_`-prefixed keys. Without
 * the `loadEnv` call in the config, `getEnv()` throws inside a worker on a
 * fully configured machine, which is why every integration test touching a
 * `getEnv()` consumer has to mock `@/lib/env` first.
 *
 * The suite below is split in two on purpose:
 *
 *   - **`dotenvFallbacks` against fixture directories** — runs everywhere,
 *     including CI. These are the real guard.
 *   - **against the developer's own `.env`** — skipped without one, i.e.
 *     skipped in CI. An end-to-end sanity check on a configured machine.
 *
 * The fixture half exists because the file-backed half could never run in CI:
 * there is no `.env` on a runner, so both tests skipped, and the mechanism
 * went unguarded on the one machine that gates merges. `envDir` is a parameter
 * purely so these can point somewhere deterministic.
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

const tempDirs: string[] = [];

/** A throwaway env dir. `files` maps a filename (`.env`, `.env.test`) to its body. */
function envFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hm-env-'));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dotenvFallbacks', () => {
  it('offers a .env value the shell has not set', () => {
    const dir = envFixture({ '.env': 'HM_FIXTURE_UNSET=from-file\n' });

    expect(dotenvFallbacks('test', dir).HM_FIXTURE_UNSET).toBe('from-file');
  });

  // The shell has to win over the file, or a `.env` carrying
  // `NODE_ENV=development` (this repo's does) would silently flip every test
  // run into development mode — Vitest sets NODE_ENV before the config is
  // evaluated, so it must be filtered out here rather than overwritten.
  it('drops any key the shell already set, rather than overriding it', () => {
    const dir = envFixture({ '.env': 'HM_FIXTURE_SET=from-file\n' });
    process.env.HM_FIXTURE_SET = 'from-shell';

    try {
      expect(dotenvFallbacks('test', dir)).not.toHaveProperty('HM_FIXTURE_SET');
    } finally {
      delete process.env.HM_FIXTURE_SET;
    }
  });

  // This is the CI path: no .env on a runner, so the whole mechanism has to
  // collapse to a no-op rather than clobbering the job's env block.
  it('collapses to a no-op when there is no .env at all', () => {
    expect(dotenvFallbacks('test', envFixture({}))).toEqual({});
  });

  // Documented in vitest.env.ts: a `.env.test` lets one machine override the
  // shared `.env` without that override being checked in.
  it('lets .env.{mode} win over .env', () => {
    const dir = envFixture({
      '.env': 'HM_FIXTURE_MODE=base\n',
      '.env.test': 'HM_FIXTURE_MODE=mode-specific\n',
    });

    expect(dotenvFallbacks('test', dir).HM_FIXTURE_MODE).toBe('mode-specific');
  });

  it('ignores comments and blank lines', () => {
    const dir = envFixture({ '.env': '# a comment\n\nHM_FIXTURE_REAL=yes\n' });
    const result = dotenvFallbacks('test', dir);

    expect(result.HM_FIXTURE_REAL).toBe('yes');
    expect(Object.keys(result)).toEqual(['HM_FIXTURE_REAL']);
  });
});

describe('vitest env loading', () => {
  it('does not let .env override a variable the runner already set', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it.skipIf(!hasDotenv)('exposes every .env key to test workers via process.env', () => {
    const missing = dotenvKeys().filter((key) => process.env[key] === undefined);
    expect(missing).toEqual([]);
  });

  it.skipIf(!hasDotenv)(
    'lets a real getEnv() consumer run without stubbing @/lib/env',
    async () => {
      const { getEnv } = await import('@/lib/env');
      expect(() => getEnv()).not.toThrow();
    },
  );
});
