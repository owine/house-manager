import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { atomicWrite, removeDir, resolveStoragePath } from './storage';

describe('resolveStoragePath', () => {
  it('returns an absolute path under FILES_DIR for a normal storage path', () => {
    const abs = resolveStoragePath('/data/files', 'abc123/original.pdf');
    expect(abs).toBe('/data/files/abc123/original.pdf');
  });

  it('rejects paths that try to escape FILES_DIR', () => {
    expect(() => resolveStoragePath('/data/files', '../etc/passwd')).toThrow(/outside FILES_DIR/);
    expect(() => resolveStoragePath('/data/files', 'abc/../../../etc/passwd')).toThrow();
  });

  it('rejects absolute storage paths', () => {
    expect(() => resolveStoragePath('/data/files', '/etc/passwd')).toThrow();
  });
});

describe('atomicWrite + removeDir', () => {
  it('writes a file and removes its directory', async () => {
    const root = await mkdtemp(`${tmpdir()}/storage-test-`);
    const rel = await atomicWrite(root, 'abc/', 'file.bin', Buffer.from('hello'));
    expect(rel).toBe('abc/file.bin');
    const content = await readFile(`${root}/abc/file.bin`);
    expect(content.toString()).toBe('hello');
    await removeDir(root, 'abc');
    await expect(readFile(`${root}/abc/file.bin`)).rejects.toThrow(/ENOENT/);
  });
});
