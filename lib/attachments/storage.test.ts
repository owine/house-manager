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
      attachmentStorageDirs({
        id: 'att1',
        storagePath: 'att1/original.pdf',
        thumbnailPath: 'att1/thumb.webp',
      }),
    ).toEqual({ dirs: ['att1'], unrecognized: [] });
  });

  // The Q-M6 bug: ingest.ts lays inbound files out under a cuid that is NOT the
  // attachment id, so recomputing the directory from the id misses it.
  it('returns the inbound directory, not one named after the attachment id', () => {
    expect(
      attachmentStorageDirs({
        id: 'att1',
        storagePath: 'inbound/ab/abcxyz123/invoice.pdf',
        thumbnailPath: null,
      }),
    ).toEqual({ dirs: ['inbound/ab/abcxyz123'], unrecognized: [] });
  });

  it('returns both directories when the thumbnail lives apart from the original', () => {
    expect(
      attachmentStorageDirs({
        id: 'att1',
        storagePath: 'inbound/ab/abcxyz123/photo.jpg',
        thumbnailPath: 'att1/thumb.webp',
      }),
    ).toEqual({ dirs: ['inbound/ab/abcxyz123', 'att1'], unrecognized: [] });
  });

  it('returns nothing for an external link', () => {
    expect(attachmentStorageDirs({ id: 'att1', storagePath: null, thumbnailPath: null })).toEqual({
      dirs: [],
      unrecognized: [],
    });
  });

  // dirname('loose.pdf') is '.', i.e. FILES_DIR itself. Returning it would
  // rm -rf every attachment in the house.
  it('never returns FILES_DIR itself for a path with no directory', () => {
    expect(
      attachmentStorageDirs({ id: 'att1', storagePath: 'loose.pdf', thumbnailPath: null }),
    ).toEqual({ dirs: [], unrecognized: [] });
  });

  // Shared-ancestor hazard: these dirnames hold OTHER rows' files too, so they
  // must never reach `dirs` (removeDir would wipe siblings' attachments).
  it('reports a bare "inbound" as unrecognized, not deletable', () => {
    expect(
      attachmentStorageDirs({ id: 'att1', storagePath: 'inbound/file.pdf', thumbnailPath: null }),
    ).toEqual({ dirs: [], unrecognized: ['inbound'] });
  });

  it('reports a bucket-only "inbound/<xx>" as unrecognized, not deletable', () => {
    expect(
      attachmentStorageDirs({
        id: 'att1',
        storagePath: 'inbound/ab/file.pdf',
        thumbnailPath: null,
      }),
    ).toEqual({ dirs: [], unrecognized: ['inbound/ab'] });
  });

  it('rejects a ".." segment disguised as the cuid, which would resolve to the shared bucket dir', () => {
    expect(
      attachmentStorageDirs({
        id: 'att1',
        storagePath: 'inbound/ab/../x.pdf',
        thumbnailPath: null,
      }),
    ).toEqual({ dirs: [], unrecognized: ['inbound/ab/..'] });
  });

  it('rejects an inbound dir whose bucket does not match the cuid prefix', () => {
    expect(
      attachmentStorageDirs({
        id: 'att1',
        storagePath: 'inbound/zz/abc123/original.pdf',
        thumbnailPath: null,
      }),
    ).toEqual({ dirs: [], unrecognized: ['inbound/zz/abc123'] });
  });

  it("rejects an upload-shaped dir that isn't this row's own id", () => {
    expect(
      attachmentStorageDirs({ id: 'att1', storagePath: 'other/original.pdf', thumbnailPath: null }),
    ).toEqual({ dirs: [], unrecognized: ['other'] });
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
