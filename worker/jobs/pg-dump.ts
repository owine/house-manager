import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Sentry from '@sentry/node';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const logger = getLogger('worker.pg-dump');
const runDump = promisify(execFile);

const BACKUP_DIR = '/backups';
const FILENAME_PREFIX = 'housemanager-';
const FILENAME_SUFFIX = '.dump';
export const RETENTION_COUNT = 7;

export type FileEntry = { name: string; mtimeMs: number };

/**
 * Given a list of dump files in the backup directory, returns the subset that
 * should be deleted to enforce RETENTION_COUNT. The newest RETENTION_COUNT
 * files are kept; the rest are pruned. Pure function — exported for testing.
 */
export function selectFilesToPrune(files: FileEntry[]): FileEntry[] {
  if (files.length <= RETENTION_COUNT) return [];
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return sorted.slice(RETENTION_COUNT);
}

/**
 * Runs `pg_dump --format=custom` against DATABASE_URL, writes the result to
 * /backups/housemanager-<ISO>.dump, then prunes the directory to the last
 * RETENTION_COUNT dumps.
 *
 * Failure modes:
 *   - pg_dump non-zero exit → log error + Sentry capture + throw (pg-boss retries)
 *   - pruning failure → log warn, do NOT throw (the dump itself was the goal)
 */
export async function handlePgDump(): Promise<{ file: string; pruned: number }> {
  const { DATABASE_URL } = getEnv();
  // ISO timestamp with `:` and `.` replaced (filesystem-safe).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${FILENAME_PREFIX}${stamp}${FILENAME_SUFFIX}`;
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    await runDump('pg_dump', ['--format=custom', `--dbname=${DATABASE_URL}`, `--file=${filepath}`]);
  } catch (e) {
    const err = e as Error & { code?: number; stderr?: string };
    logger.error({ err, exitCode: err.code, stderr: err.stderr }, 'pg_dump failed');
    Sentry.captureException(err);
    throw err;
  }

  const stat = await fs.stat(filepath);
  logger.info({ file: filename, sizeBytes: stat.size }, 'pg_dump completed');

  // Pruning is best-effort.
  let pruned = 0;
  try {
    const entries = await fs.readdir(BACKUP_DIR);
    const candidates: FileEntry[] = [];
    for (const name of entries) {
      if (!name.startsWith(FILENAME_PREFIX) || !name.endsWith(FILENAME_SUFFIX)) continue;
      const s = await fs.stat(path.join(BACKUP_DIR, name));
      candidates.push({ name, mtimeMs: s.mtimeMs });
    }
    const toPrune = selectFilesToPrune(candidates);
    for (const f of toPrune) {
      await fs.unlink(path.join(BACKUP_DIR, f.name));
      pruned += 1;
    }
    if (pruned > 0) {
      logger.info({ pruned }, 'pruned old dumps');
    }
  } catch (e) {
    logger.warn({ err: e }, 'pruning failed (non-fatal)');
  }

  return { file: filename, pruned };
}
