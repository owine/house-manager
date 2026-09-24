import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { atomicWrite, attachmentStorageDirs, removeDir, resolveStoragePath } from './storage';

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

describe('attachmentStorageDirs', () => {
  it('returns the upload directory once when original and thumbnail share it', () => {
    expect(
      attachmentStorageDirs({ storagePath: 'att1/original.pdf', thumbnailPath: 'att1/thumb.webp' }),
    ).toEqual(['att1']);
  });

  // The Q-M6 bug: ingest.ts lays inbound files out under a cuid that is NOT the
  // attachment id, so recomputing the directory from the id misses it.
  it('returns the inbound directory, not one named after the attachment id', () => {
    expect(
      attachmentStorageDirs({ storagePath: 'inbound/ab/cxyz/invoice.pdf', thumbnailPath: null }),
    ).toEqual(['inbound/ab/cxyz']);
  });

  it('returns both directories when the thumbnail lives apart from the original', () => {
    expect(
      attachmentStorageDirs({
        storagePath: 'inbound/ab/cxyz/photo.jpg',
        thumbnailPath: 'att1/thumb.webp',
      }),
    ).toEqual(['inbound/ab/cxyz', 'att1']);
  });

  it('returns nothing for an external link', () => {
    expect(attachmentStorageDirs({ storagePath: null, thumbnailPath: null })).toEqual([]);
  });

  // dirname('loose.pdf') is '.', i.e. FILES_DIR itself. Returning it would
  // rm -rf every attachment in the house.
  it('never returns FILES_DIR itself for a path with no directory', () => {
    expect(attachmentStorageDirs({ storagePath: 'loose.pdf', thumbnailPath: null })).toEqual([]);
  });
});

describe('removeDir', () => {
  it('refuses to remove FILES_DIR itself', async () => {
    const root = await mkdtemp(`${tmpdir()}/storage-test-`);
    await writeFile(`${root}/sentinel`, 'keep');

    await expect(removeDir(root, '')).rejects.toThrow(/FILES_DIR itself/);
    await expect(removeDir(root, '.')).rejects.toThrow(/FILES_DIR itself/);

    expect((await readFile(`${root}/sentinel`)).toString()).toBe('keep');
  });
});
