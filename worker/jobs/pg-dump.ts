import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Sentry from '@sentry/node';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.pg-dump');
const execFileAsync = promisify(execFile);

const BACKUP_DIR = '/backups';
const FILENAME_PREFIX = 'housemanager-';
const FILENAME_SUFFIX = '.dump';
// In-flight output is written as `.housemanager-<ISO>.dump.partial`. The
// leading dot and the extra suffix mean it can never match the retention
// pattern, so a dump that dies mid-write can never be counted as a backup.
const PARTIAL_PREFIX = `.${FILENAME_PREFIX}`;
const PARTIAL_SUFFIX = '.partial';
export const RETENTION_COUNT = 7;
/**
 * A `.partial` older than this is debris from a killed run (SIGKILL, OOM, a
 * container stop mid-dump), never a run still in flight: the job is daily and
 * pg-boss expires an attempt after 15 minutes.
 */
export const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export type FileEntry = { name: string; mtimeMs: number };

/** execFile, narrowed to what this job needs. Injectable so tests need no pg_dump. */
export type RunCommand = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

type PgDumpDeps = {
  backupDir: string;
  run: RunCommand;
  fetch: typeof fetch;
  heartbeatTimeoutMs: number;
};

const defaultRun: RunCommand = (file, args, options) =>
  // 16 MiB: `pg_restore --list` prints one line per archive object, and
  // execFile's 1 MiB default would kill it on a large schema.
  execFileAsync(file, args, { env: options.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

export type PgDumpResult = {
  file: string;
  sizeBytes: number;
  durationMs: number;
  pruned: number;
  heartbeat: 'sent' | 'skipped' | 'failed';
};

/**
 * Split the DB password out of the connection string so it never lands in
 * `pg_dump`'s argv (which would otherwise be logged on error / sent to Sentry
 * via the Error's `cmd`/`spawnargs`). The password is passed to pg_dump through
 * the `PGPASSWORD` env var instead; the `--dbname` URL keeps host/user/db/params
 * but not the password. Pure + exported for testing.
 */
export function buildDumpInvocation(
  databaseUrl: string,
  filepath: string,
): { args: string[]; password?: string } {
  const u = new URL(databaseUrl);
  let password: string | undefined;
  if (u.password) {
    try {
      password = decodeURIComponent(u.password);
    } catch {
      // Malformed percent-encoding (e.g. a literal '%' in the password) would
      // make decodeURIComponent throw and abort the backup. Fall back to the raw
      // value — still kept out of argv, just not URL-decoded.
      password = u.password;
    }
  }
  u.password = '';
  return {
    args: ['--format=custom', `--dbname=${u.toString()}`, `--file=${filepath}`],
    password,
  };
}

/**
 * Given a list of dump files in the backup directory, returns the subset that
 * should be deleted so that only the newest `keep` (default RETENTION_COUNT)
 * remain. Pure function — exported for testing. Callers must pass only
 * VALIDATED dumps (see pruneBackupDir).
 */
export function selectFilesToPrune(files: FileEntry[], keep = RETENTION_COUNT): FileEntry[] {
  if (files.length <= keep) return [];
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return sorted.slice(keep);
}

/**
 * Dump to a temp file, prove it is a readable archive, then rename it into
 * place. `rename` within one directory is atomic, so a `housemanager-*.dump`
 * either is a complete, validated archive or does not exist.
 */
async function dumpAndValidate(
  deps: PgDumpDeps,
  databaseUrl: string,
  partialPath: string,
  finalPath: string,
): Promise<number> {
  const { args, password } = buildDumpInvocation(databaseUrl, partialPath);
  await deps.run('pg_dump', args, {
    env: password ? { ...process.env, PGPASSWORD: password } : process.env,
  });

  // pg_dump creates its output file before it connects, so an early failure
  // leaves an empty file. Exit 0 with zero bytes should not happen; if it does,
  // it is not a backup.
  const { size } = await fs.stat(partialPath);
  if (size === 0) throw new Error('pg_dump exited 0 but wrote an empty file');

  // Reads the archive header and table of contents. That catches a truncated
  // or foreign file, and a dump with no table data (e.g. DATABASE_URL pointing
  // at an empty database) is not a backup either.
  const { stdout } = await deps.run('pg_restore', ['--list', partialPath], { env: process.env });
  if (!stdout.includes(' TABLE DATA ')) {
    throw new Error('pg_restore --list found no TABLE DATA entries in the dump');
  }

  await fs.rename(partialPath, finalPath);
  return size;
}

/**
 * Enforce retention over VALIDATED dumps only, and clear debris. Best-effort:
 * returns the number of dumps pruned, logs and swallows its own failures.
 *
 * - `housemanager-*.dump` with size > 0 → retention candidate. Since the
 *   rename above, a file of that name is always a validated archive.
 * - `housemanager-*.dump` with size 0 → left by the pre-fix job when pg_dump
 *   failed. Carries no data; removed, never counted.
 * - `.housemanager-*.dump.partial` older than STALE_PARTIAL_MS → removed.
 * - anything else → never touched.
 *
 * `current` (the dump this run just validated) is never a prune candidate and
 * takes one of the RETENTION_COUNT slots. Ordering is by mtime, so without
 * this a clock that stepped backwards (NTP correction, a host restored from a
 * snapshot) would make tonight's dump look like the oldest and delete it.
 */
async function pruneBackupDir(backupDir: string, current: string): Promise<number> {
  let pruned = 0;
  try {
    const now = Date.now();
    const candidates: FileEntry[] = [];
    for (const name of await fs.readdir(backupDir)) {
      const full = path.join(backupDir, name);
      if (name.startsWith(PARTIAL_PREFIX) && name.endsWith(PARTIAL_SUFFIX)) {
        const s = await fs.stat(full);
        if (now - s.mtimeMs > STALE_PARTIAL_MS) {
          await fs.rm(full, { force: true });
          logger.warn(
            { event: 'pg-dump.partial.removed', file: name },
            'removed stale partial dump',
          );
        }
        continue;
      }
      if (name === current) continue;
      if (!name.startsWith(FILENAME_PREFIX) || !name.endsWith(FILENAME_SUFFIX)) continue;
      const s = await fs.stat(full);
      if (!s.isFile()) continue;
      if (s.size === 0) {
        await fs.rm(full, { force: true });
        logger.warn({ event: 'pg-dump.empty.removed', file: name }, 'removed empty dump');
        continue;
      }
      candidates.push({ name, mtimeMs: s.mtimeMs });
    }
    for (const f of selectFilesToPrune(candidates, RETENTION_COUNT - 1)) {
      await fs.unlink(path.join(backupDir, f.name));
      pruned += 1;
    }
    if (pruned > 0) logger.info({ event: 'pg-dump.pruned', pruned }, 'pruned old dumps');
  } catch (e) {
    logger.warn({ err: e }, 'pruning failed (non-fatal)');
  }
  return pruned;
}

/**
 * Dead-man ping. Fail-soft: a monitor outage must never fail the backup, and a
 * missed ping is exactly what the monitor alerts on.
 *
 * Never logs the URL, and never logs an error's `message`: undici puts the full
 * request URL in some of its errors, and this URL carries the push token (and
 * could carry `user:pass@` — httpUrlSchema allows credentials). Only the error's
 * name and its cause's `code` (e.g. ECONNREFUSED, ENOTFOUND) are logged.
 */
async function pingHeartbeat(
  url: string | undefined,
  deps: PgDumpDeps,
): Promise<PgDumpResult['heartbeat']> {
  if (!url) return 'skipped';
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(deps.heartbeatTimeoutMs) });
    if (!res.ok) {
      logger.warn(
        { event: 'pg-dump.heartbeat.failed', status: res.status },
        'backup heartbeat rejected (non-fatal)',
      );
      return 'failed';
    }
    return 'sent';
  } catch (e) {
    const err = e as Error;
    logger.warn(
      {
        event: 'pg-dump.heartbeat.failed',
        errName: err.name,
        causeCode: (err.cause as { code?: string } | undefined)?.code,
      },
      'backup heartbeat failed (non-fatal)',
    );
    return 'failed';
  }
}

/**
 * Runs `pg_dump --format=custom` against DATABASE_URL into a temp file,
 * validates it, renames it to <backupDir>/housemanager-<ISO>.dump, prunes the
 * directory to the last RETENTION_COUNT valid dumps, then pings
 * BACKUP_HEARTBEAT_URL if set.
 *
 * Failure modes:
 *   - pg_dump fails, output empty, or `pg_restore --list` rejects it → temp
 *     file deleted, NO prune, NO heartbeat, log error + Sentry + throw (pg-boss
 *     retries). The monitor goes red because the ping never comes.
 *   - pruning failure → log warn, do NOT throw (the dump itself was the goal)
 *   - heartbeat failure → log warn, do NOT throw
 *
 * `overrides` exists for tests. The worker calls this with no arguments.
 */
export async function handlePgDump(overrides: Partial<PgDumpDeps> = {}): Promise<PgDumpResult> {
  const deps: PgDumpDeps = {
    backupDir: BACKUP_DIR,
    run: defaultRun,
    fetch: globalThis.fetch,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    ...overrides,
  };
  const { DATABASE_URL, BACKUP_HEARTBEAT_URL } = getEnv();
  const startedAt = Date.now();
  // ISO timestamp with `:` and `.` replaced (filesystem-safe).
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const filename = `${FILENAME_PREFIX}${stamp}${FILENAME_SUFFIX}`;
  const finalPath = path.join(deps.backupDir, filename);
  const partialPath = path.join(deps.backupDir, `.${filename}${PARTIAL_SUFFIX}`);

  let sizeBytes: number;
  try {
    sizeBytes = await dumpAndValidate(deps, DATABASE_URL, partialPath, finalPath);
  } catch (e) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    const err = e as Error & { code?: number | string; stderr?: string };
    // Log only safe fields — the raw Error carries `cmd`/`spawnargs`. Those no
    // longer contain the password (it's in PGPASSWORD), but keep the log narrow.
    logger.error(
      { event: 'pg-dump.failed', message: err.message, code: err.code, stderr: err.stderr },
      'pg_dump failed',
    );
    Sentry.captureException(err);
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { event: 'pg-dump.completed', file: filename, sizeBytes, durationMs },
    'pg_dump completed',
  );

  const pruned = await pruneBackupDir(deps.backupDir, filename);
  const heartbeat = await pingHeartbeat(BACKUP_HEARTBEAT_URL, deps);
  return { file: filename, sizeBytes, durationMs, pruned, heartbeat };
}
