import { describe, expect, it } from 'vitest';
import { buildDumpInvocation, RETENTION_COUNT, selectFilesToPrune } from './pg-dump';

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
