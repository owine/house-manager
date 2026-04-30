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

/** Recursive remove of FILES_DIR/<dir>. Idempotent. */
export async function removeDir(filesDir: string, dir: string): Promise<void> {
  const abs = resolveStoragePath(filesDir, dir);
  await rm(abs, { recursive: true, force: true });
}

/** Open a read stream for downloads. Caller resolves the path first. */
export function openReadStream(absPath: string) {
  return createReadStream(absPath);
}
