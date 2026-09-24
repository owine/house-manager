import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDumpInvocation,
  handlePgDump,
  PG_DUMP_TIMEOUT_MS,
  PG_RESTORE_LIST_TIMEOUT_MS,
  RETENTION_COUNT,
  type RunCommand,
  STALE_PARTIAL_MS,
  selectFilesToPrune,
} from './pg-dump';

// Only the two fields handlePgDump reads. Mutable per test via `env`.
const env = vi.hoisted(() => ({
  DATABASE_URL: 'postgresql://housemanager:pw@db:5432/housemanager',
  BACKUP_HEARTBEAT_URL: undefined as string | undefined,
}));
vi.mock('@/lib/env', () => ({ getEnv: () => env }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
// Captured so tests can assert what is (and is never) logged.
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ getLogger: () => log }));

describe('buildDumpInvocation', () => {
  const URL_WITH_PW =
    'postgresql://housemanager:s3cr3tP%40ss@db-host:5432/housemanager?sslmode=require';

  it('keeps the password out of argv and returns it separately for PGPASSWORD', () => {
    const { args, password } = buildDumpInvocation(URL_WITH_PW, '/backups/x.dump');
    expect(password).toBe('s3cr3tP@ss'); // decoded for libpq
    const argv = args.join(' ');
    expect(argv).not.toContain('s3cr3tP'); // no password anywhere in argv
    expect(argv).not.toContain('%40ss');
    // dbname keeps host/user/db/params, drops the password
    expect(args).toContainEqual(
      '--dbname=postgresql://housemanager@db-host:5432/housemanager?sslmode=require',
    );
    expect(args).toContain('--format=custom');
    expect(args).toContain('--file=/backups/x.dump');
    // Fails fast against a table lock instead of queueing behind it, well under
    // the process-level timeout below (60s << 10min).
    expect(args).toContain('--lock-wait-timeout=60s');
  });

  it('does not throw on malformed percent-encoding in the password', () => {
    // A literal '%' (invalid escape) would make decodeURIComponent throw.
    const url = 'postgresql://user:ab%cd@host:5432/db';
    expect(() => buildDumpInvocation(url, '/backups/z.dump')).not.toThrow();
    const { args, password } = buildDumpInvocation(url, '/backups/z.dump');
    expect(password).toBe('ab%cd'); // raw fallback
    expect(args.join(' ')).not.toContain('ab%cd'); // still absent from argv
  });

  it('returns no password when the URL has none', () => {
    const { args, password } = buildDumpInvocation(
      'postgresql://user@host:5432/db',
      '/backups/y.dump',
    );
    expect(password).toBeUndefined();
    expect(args).toContainEqual('--dbname=postgresql://user@host:5432/db');
  });
});

describe('selectFilesToPrune', () => {
  it('returns empty when count <= retention', () => {
    const files = [
      { name: 'housemanager-2026-05-03T03-00-00Z.dump', mtimeMs: 1_000_000 },
      { name: 'housemanager-2026-05-02T03-00-00Z.dump', mtimeMs: 900_000 },
    ];
    expect(selectFilesToPrune(files)).toEqual([]);
  });

  it('keeps the newest RETENTION_COUNT and returns the rest for deletion', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `housemanager-day-${i}.dump`,
      mtimeMs: 1_000_000 - i * 1000, // index 0 is newest
    }));
    const toPrune = selectFilesToPrune(files);
    expect(toPrune).toHaveLength(10 - RETENTION_COUNT);
    expect(toPrune.map((f) => f.name).sort()).toEqual(
      ['housemanager-day-7.dump', 'housemanager-day-8.dump', 'housemanager-day-9.dump'].sort(),
    );
  });

  it('handles unsorted input by mtime', () => {
    const files = [
      { name: 'old.dump', mtimeMs: 100 },
      { name: 'new.dump', mtimeMs: 1000 },
      { name: 'middle.dump', mtimeMs: 500 },
    ];
    expect(selectFilesToPrune(files)).toEqual([]);
  });
});

// --- handlePgDump orchestration -------------------------------------------
//
// A real temp directory and a fake `run`, so every assertion is about files
// that actually exist on disk. The fake mimics the real tools' observable
// behaviour, including the one that caused O-M4: pg_dump creates its --file
// BEFORE connecting, so a failed run leaves a 0-byte file behind (reproduced
// with pg_dump 18.6 against an unreachable host).

type FakeOpts = {
  dumpFails?: boolean;
  dumpBytes?: number;
  listFails?: boolean;
  listOutput?: string;
  // execFile's actual shape when `timeout` fires and the child is killed
  // (observed locally: `{ killed: true, signal: 'SIGKILL', code: null }`,
  // message "Command failed: …" — see worker/jobs/pg-dump.ts `defaultRun`).
  dumpTimesOut?: boolean;
};

const GOOD_LISTING =
  ';\n; Archive created at 2026-09-24 03:00:00 UTC\n;\n' +
  '3391; 0 16415 TABLE DATA public items housemanager\n';

function fakeRun(opts: FakeOpts = {}) {
  const calls: Array<{
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    timeoutMs: number | undefined;
  }> = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs });
    if (file === 'pg_dump') {
      const fileArg = args.find((a) => a.startsWith('--file='));
      if (!fileArg) throw new Error('fake pg_dump: no --file');
      const target = fileArg.slice('--file='.length);
      const empty = opts.dumpFails || opts.dumpTimesOut;
      await fs.writeFile(target, Buffer.alloc(empty ? 0 : (opts.dumpBytes ?? 64), 1));
      if (opts.dumpTimesOut) {
        throw Object.assign(new Error('Command failed: pg_dump'), {
          killed: true,
          signal: 'SIGKILL',
          code: null,
        });
      }
      if (opts.dumpFails) {
        throw Object.assign(new Error('Command failed: pg_dump'), {
          code: 1,
          stderr: 'connection refused',
        });
      }
      return { stdout: '', stderr: '' };
    }
    if (file === 'pg_restore') {
      if (opts.listFails) {
        throw Object.assign(new Error('Command failed: pg_restore --list'), {
          code: 1,
          stderr: 'pg_restore: error: input file is too short',
        });
      }
      return { stdout: opts.listOutput ?? GOOD_LISTING, stderr: '' };
    }
    throw new Error(`fake run: unexpected command ${file}`);
  };
  return { run, calls };
}

const okFetch = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-dump-test-'));
  env.BACKUP_HEARTBEAT_URL = undefined;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A pre-existing file with a chosen age. */
async function seedFile(name: string, ageMs: number, bytes = 64): Promise<void> {
  const full = path.join(dir, name);
  await fs.writeFile(full, Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(full, t, t);
}

/** Seven valid dumps, 1..7 days old. */
async function seedSevenGoodDumps(): Promise<string[]> {
  const names = Array.from({ length: RETENTION_COUNT }, (_, i) => `housemanager-old-${i + 1}.dump`);
  for (const [i, name] of names.entries()) await seedFile(name, (i + 1) * 86_400_000);
  return names;
}

const listDir = async () => (await fs.readdir(dir)).sort();

describe('handlePgDump', () => {
  it('dumps to a .partial, validates it, then renames it into place', async () => {
    const { run, calls } = fakeRun();
    const result = await handlePgDump({ backupDir: dir, run, fetch: okFetch() });

    expect(result.file).toMatch(/^housemanager-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dump$/);
    expect(result.sizeBytes).toBe(64);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(await listDir()).toEqual([result.file]);

    const partial = path.join(dir, `.${result.file}.partial`);
    expect(calls.map((c) => c.file)).toEqual(['pg_dump', 'pg_restore']);
    expect(calls[0].args).toContain(`--file=${partial}`);
    expect(calls[0].env.PGPASSWORD).toBe('pw');
    expect(calls[1].args).toEqual(['--list', partial]);
    // Bounded so a wedged pg_dump/pg_restore fails clean instead of hanging
    // forever: pg-boss expires the attempt at 15min (no policy for `pg-dump`
    // in lib/queue.ts QUEUE_POLICY, so it gets the default expireInSeconds
    // 900), and these stay comfortably under that.
    // Hardcoded literals, not just `toBe(PG_DUMP_TIMEOUT_MS)`: the exported
    // constant and the value defaultRun actually forwards to execFile must
    // both be right, or this assertion would pass trivially on two matching
    // `undefined`s.
    expect(calls[0].timeoutMs).toBe(600_000);
    expect(calls[1].timeoutMs).toBe(120_000);
    expect(PG_DUMP_TIMEOUT_MS).toBe(600_000);
    expect(PG_RESTORE_LIST_TIMEOUT_MS).toBe(120_000);
  });

  it('on pg_dump failure: leaves no file, does not prune, reports, and rethrows', async () => {
    const survivors = await seedSevenGoodDumps();
    await seedFile('housemanager-old-8.dump', 8 * 86_400_000); // would be pruned on success
    const fetch = okFetch();
    env.BACKUP_HEARTBEAT_URL = 'https://kuma.example/api/push/abc';

    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ dumpFails: true }).run, fetch }),
    ).rejects.toThrow('Command failed: pg_dump');

    expect(await listDir()).toEqual([...survivors, 'housemanager-old-8.dump'].sort());
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  // A timeout-killed child looks like `{ killed: true, signal: 'SIGKILL', code:
  // null }` (verified against real execFile), not `{ code: 1, stderr }`. The
  // generic catch in handlePgDump must treat it exactly like any other failure.
  it('on pg_dump timeout: leaves no file, does not prune, reports, and rethrows', async () => {
    const survivors = await seedSevenGoodDumps();
    await seedFile('housemanager-old-8.dump', 8 * 86_400_000);
    const fetch = okFetch();
    env.BACKUP_HEARTBEAT_URL = 'https://kuma.example/api/push/abc';

    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ dumpTimesOut: true }).run, fetch }),
    ).rejects.toThrow('Command failed: pg_dump');

    expect(await listDir()).toEqual([...survivors, 'housemanager-old-8.dump'].sort());
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty dump even when pg_dump exits 0', async () => {
    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ dumpBytes: 0 }).run, fetch: okFetch() }),
    ).rejects.toThrow(/empty file/);
    expect(await listDir()).toEqual([]);
  });

  it('rejects a dump that pg_restore --list cannot read, and does not prune', async () => {
    const survivors = await seedSevenGoodDumps();
    await seedFile('housemanager-old-8.dump', 8 * 86_400_000);

    await expect(
      handlePgDump({ backupDir: dir, run: fakeRun({ listFails: true }).run, fetch: okFetch() }),
    ).rejects.toThrow(/pg_restore --list/);
    expect(await listDir()).toEqual([...survivors, 'housemanager-old-8.dump'].sort());
  });

  it('rejects a dump whose listing has no table data', async () => {
    const run = fakeRun({ listOutput: ';\n; Archive created at 2026-09-24\n' }).run;
    await expect(handlePgDump({ backupDir: dir, run, fetch: okFetch() })).rejects.toThrow(
      /no TABLE DATA/,
    );
    expect(await listDir()).toEqual([]);
  });

  it('prunes to RETENTION_COUNT valid dumps after a success, newest kept', async () => {
    const old = await seedSevenGoodDumps(); // old-1 newest … old-7 oldest
    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(1);
    expect(await listDir()).toEqual([result.file, ...old.slice(0, RETENTION_COUNT - 1)].sort());
  });

  // O-M4: two bad nights under the old job left six 0-byte dumps NEWER than
  // every good one, and the pruner then deleted the good ones to make room.
  it('never counts 0-byte dumps toward retention, and removes them', async () => {
    const old = await seedSevenGoodDumps();
    for (let i = 0; i < 3; i++) await seedFile(`housemanager-empty-${i}.dump`, 3_600_000, 0);

    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(1); // only old-7 goes; the empties never displaced a good dump
    expect(await listDir()).toEqual([result.file, ...old.slice(0, RETENTION_COUNT - 1)].sort());
  });

  // Retention sorts by mtime. If the clock stepped backwards, every existing
  // dump looks newer than tonight's, and a plain newest-7 would delete it.
  it('never prunes the dump it just made, even if the clock stepped backwards', async () => {
    const future = Array.from(
      { length: RETENTION_COUNT },
      (_, i) => `housemanager-future-${i + 1}.dump`,
    );
    for (const [i, name] of future.entries()) await seedFile(name, -(i + 1) * 86_400_000);

    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(1); // future-1, the oldest of the others
    expect(await listDir()).toEqual([result.file, ...future.slice(1)].sort());
  });

  it('never touches files outside the housemanager-*.dump pattern', async () => {
    await seedSevenGoodDumps();
    await seedFile('notes.txt', 30 * 86_400_000);
    await seedFile('other-app.dump', 30 * 86_400_000);
    await seedFile('housemanager-manual.sql', 30 * 86_400_000);

    await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    const names = await listDir();
    expect(names).toContain('notes.txt');
    expect(names).toContain('other-app.dump');
    expect(names).toContain('housemanager-manual.sql');
  });

  it('removes stale .partial leftovers but not recent ones', async () => {
    await seedFile('.housemanager-killed.dump.partial', STALE_PARTIAL_MS + 3_600_000);
    await seedFile('.housemanager-recent.dump.partial', 60_000);

    await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    const names = await listDir();
    expect(names).not.toContain('.housemanager-killed.dump.partial');
    expect(names).toContain('.housemanager-recent.dump.partial');
  });

  // A dangling symlink named like a dump makes fs.stat throw ENOENT. That
  // must not abort pruning of the real entries around it (a single outer
  // try/catch would silently stop the whole prune here and leave the disk
  // growing unbounded every subsequent run).
  it('skips a dangling symlink instead of aborting the whole prune', async () => {
    const oldNames = Array.from({ length: 8 }, (_, i) => `housemanager-old-${i + 1}.dump`);
    for (const [i, name] of oldNames.entries()) await seedFile(name, (i + 1) * 86_400_000);
    await fs.symlink(
      path.join(dir, 'housemanager-ghost-target.dump'),
      path.join(dir, 'housemanager-ghost.dump'),
    );

    const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    expect(result.pruned).toBe(2); // 8 old -> keep newest 6 + current = 7 real dumps
    const names = await listDir();
    expect(names).toContain('housemanager-ghost.dump'); // dangling symlink untouched, never a candidate
    const realDumps = names.filter((n) => n !== 'housemanager-ghost.dump');
    expect(realDumps).toEqual([result.file, ...oldNames.slice(0, RETENTION_COUNT - 1)].sort());
  });

  // A directory named like a stale `.partial` makes fs.rm throw EISDIR (no
  // `recursive: true` is ever added). That must not abort cleanup of the
  // real stale partials around it.
  it('leaves a directory named like a stale .partial alone, and still removes real stale partials', async () => {
    await seedFile('.housemanager-killed.dump.partial', STALE_PARTIAL_MS + 3_600_000);
    const staleDir = path.join(dir, '.housemanager-dir.dump.partial');
    await fs.mkdir(staleDir);
    const staleTime = new Date(Date.now() - (STALE_PARTIAL_MS + 3_600_000));
    await fs.utimes(staleDir, staleTime, staleTime);

    await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch: okFetch() });

    const names = await listDir();
    expect(names).not.toContain('.housemanager-killed.dump.partial');
    expect(names).toContain('.housemanager-dir.dump.partial');
  });

  describe('heartbeat', () => {
    const PUSH_URL = 'https://kuma.example/api/push/abc123?status=up&msg=OK&ping=';

    it('is skipped when BACKUP_HEARTBEAT_URL is unset', async () => {
      const fetch = okFetch();
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('skipped');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('GETs the URL verbatim, with a timeout signal, after a validated dump', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      const fetch = okFetch();
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('sent');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(PUSH_URL, { signal: expect.any(AbortSignal) });
    });

    it('is fail-soft on a non-2xx response', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      const fetch = vi.fn(async () => new Response('{"ok":false}', { status: 404 }));
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('failed');
      expect(await listDir()).toEqual([result.file]);
    });

    it('is fail-soft on a network error', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      const fetch = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });
      expect(result.heartbeat).toBe('failed');
      expect(await listDir()).toEqual([result.file]);
    });

    // undici puts the request URL in some error messages, and this URL carries
    // the push token (and could carry user:pass@). Only the error's name and
    // its cause's code may reach the log.
    it('never logs the URL or its secrets when the ping throws', async () => {
      // Built from parts (not one literal) so it's still a genuine embedded-
      // credential URL at runtime without pattern-matching as a real secret.
      const user = 'kuma-user';
      const pass = 's3cretPass';
      const secretUrl = `https://${user}:${pass}@kuma.example/api/push/tok3nSecret?status=up`;
      env.BACKUP_HEARTBEAT_URL = secretUrl;
      const fetch = vi.fn(async () => {
        throw Object.assign(new TypeError(`fetch failed: ${secretUrl}`), {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${secretUrl}`), {
            code: 'ECONNREFUSED',
          }),
        });
      });

      const result = await handlePgDump({ backupDir: dir, run: fakeRun().run, fetch });

      expect(result.heartbeat).toBe('failed');
      expect(log.warn).toHaveBeenCalledWith(
        { event: 'pg-dump.heartbeat.failed', errName: 'TypeError', causeCode: 'ECONNREFUSED' },
        expect.any(String),
      );
      const everything = JSON.stringify([
        log.debug.mock.calls,
        log.info.mock.calls,
        log.warn.mock.calls,
        log.error.mock.calls,
      ]);
      for (const secret of ['s3cretPass', 'tok3nSecret', 'kuma-user', 'kuma.example']) {
        expect(everything).not.toContain(secret);
      }
    });

    it('is fail-soft when the monitor never answers (timeout)', async () => {
      env.BACKUP_HEARTBEAT_URL = PUSH_URL;
      // Never settles on its own; only the abort signal ends it.
      const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (signal) signal.addEventListener('abort', () => reject(signal.reason));
        });
      });
      const result = await handlePgDump({
        backupDir: dir,
        run: fakeRun().run,
        fetch,
        heartbeatTimeoutMs: 20,
      });
      expect(result.heartbeat).toBe('failed');
    });
  });
});
