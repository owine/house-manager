import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a storage path (relative, e.g. "abc123/original.pdf") against
 * FILES_DIR and verify the result stays under FILES_DIR. Throws on traversal.
 */
export function resolveStoragePath(filesDir: string, storagePath: string): string {
  if (path.isAbsolute(storagePath)) {
    throw new Error(`storagePath must be relative: ${storagePath}`);
  }
  const abs = path.resolve(filesDir, storagePath);
  const rel = path.relative(filesDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`storagePath resolves outside FILES_DIR: ${storagePath}`);
  }
  return abs;
}

/**
 * Atomically write bytes to FILES_DIR/<dir>/<name>: temp file in the same
 * directory then rename. The directory is created if missing.
 */
export async function atomicWrite(
  filesDir: string,
  dir: string,
  name: string,
  data: Buffer,
): Promise<string> {
  const dirAbs = resolveStoragePath(filesDir, dir);
  await mkdir(dirAbs, { recursive: true });
  const finalAbs = path.join(dirAbs, name);
  const tempAbs = path.join(dirAbs, `.${name}.tmp-${process.pid}`);
  await writeFile(tempAbs, data);
  await rename(tempAbs, finalAbs);
  return path.relative(filesDir, finalAbs);
}

/**
 * Recursive remove of FILES_DIR/<dir>. Idempotent.
 *
 * Refuses FILES_DIR itself: `resolveStoragePath` accepts '' and '.' (they do
 * not escape the root, they ARE the root), and a recursive remove of the root
 * would take every stored file with it.
 */
export async function removeDir(filesDir: string, dir: string): Promise<void> {
  const abs = resolveStoragePath(filesDir, dir);
  if (path.relative(filesDir, abs) === '') {
    throw new Error(`refusing to remove FILES_DIR itself (dir: ${JSON.stringify(dir)})`);
  }
  await rm(abs, { recursive: true, force: true });
}

// Matches ingest.ts's `inbound/${id.slice(0, 2)}/${id}` layout: exactly three
// segments, cuid2's lowercase alnum charset (rejects '.'/'..' segments, which
// the looser `[^/]+` would accept — `inbound/ab/..` resolves to the shared
// `inbound/ab`), and the bucket equal to the cuid's own first two characters.
const INBOUND_DIR = /^inbound\/([a-z0-9]{2})\/(\1[a-z0-9]+)$/;

/**
 * The directories an attachment's files live in, relative to FILES_DIR.
 *
 * Derived from the STORED paths, never recomputed from the attachment id,
 * because the writers disagree on layout:
 *   - upload:    `<attachmentId>/original.<ext>`         (lib/attachments/actions.ts)
 *   - thumbnail: `<attachmentId>/thumb.webp`              (worker/jobs/thumbnail.ts)
 *   - inbound:   `inbound/<xx>/<cuid>/original.<ext>`     (lib/incoming-email/ingest.ts)
 *                with a cuid unrelated to the row id
 *
 * A directory is only ever returned when it is recognizably THIS row's own —
 * either `<row.id>` or the inbound `inbound/<xx>/<cuid>` shape. Every other
 * dirname (including a bare `inbound` or `inbound/<xx>`, which are shared
 * ancestors holding other rows' files) is reported as `unrecognized` and left
 * on disk rather than deleted: this function only ever returns this row's own
 * directory; unknown shapes are left on disk.
 */
export function attachmentStorageDirs(row: {
  id: string;
  storagePath: string | null;
  thumbnailPath: string | null;
}): { dirs: string[]; unrecognized: string[] } {
  const dirs = new Set<string>();
  const unrecognized = new Set<string>();
  for (const p of [row.storagePath, row.thumbnailPath]) {
    if (!p) continue;
    const dir = path.dirname(p);
    if (dir === '.' || dir === '' || path.isAbsolute(dir)) continue;
    if (dir === row.id || INBOUND_DIR.test(dir)) {
      dirs.add(dir);
    } else {
      unrecognized.add(dir);
    }
  }
  return { dirs: [...dirs], unrecognized: [...unrecognized] };
}

/** Open a read stream for downloads. Caller resolves the path first. */
export function openReadStream(absPath: string) {
  return createReadStream(absPath);
}
