import { describe, expect, it } from 'vitest';
import { deepScrubStrings, scrubSecrets } from './log-scrub';

describe('scrubSecrets', () => {
  it('masks the password in a postgres connection string, keeping scheme/user/host', () => {
    // Real connection strings percent-encode reserved chars (e.g. @ -> %40).
    const out = scrubSecrets(
      'postgresql://housemanager:s3cr3tP%40ss@db-host:5432/housemanager?sslmode=require',
    );
    expect(out).not.toContain('s3cr3tP');
    expect(out).not.toContain('%40ss');
    expect(out).toContain('postgresql://housemanager:***@db-host:5432/housemanager');
  });

  it('masks passwords in other URI schemes (redis, amqp, mongodb)', () => {
    expect(scrubSecrets('redis://default:hunter2@cache:6379')).toBe(
      'redis://default:***@cache:6379',
    );
    expect(scrubSecrets('amqp://guest:guestpw@rabbit:5672')).toBe('amqp://guest:***@rabbit:5672');
  });

  it('masks PGPASSWORD in a command/env string', () => {
    expect(scrubSecrets('PGPASSWORD=topsecret pg_dump --file=x')).toBe(
      'PGPASSWORD=*** pg_dump --file=x',
    );
  });

  it('masks Bearer and Basic authorization tokens', () => {
    expect(scrubSecrets('Authorization: Bearer abc123.def456-GHI')).toBe(
      'Authorization: Bearer ***',
    );
    expect(scrubSecrets('basic dXNlcjpwYXNz')).toBe('basic ***');
  });

  it('masks Anthropic-style api keys', () => {
    expect(scrubSecrets('key=sk-ant-api03-AbCdEf0123456789')).toBe('key=sk-***');
    expect(scrubSecrets('sk-proj-ABCDEFGHIJKL')).toBe('sk-***');
  });

  it('leaves ordinary text untouched (no false positives)', () => {
    const text = 'pg_dump completed: 12 rows, 3.4 MB written to /backups/x.dump';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('does not mangle a URL that has no password', () => {
    expect(scrubSecrets('postgresql://user@host:5432/db')).toBe('postgresql://user@host:5432/db');
  });
});

describe('deepScrubStrings', () => {
  it('scrubs strings nested in objects and arrays', () => {
    const input = {
      msg: 'ok',
      err: { cmd: 'pg_dump', spawnargs: ['--dbname=postgresql://u:p4ss@h:5432/db'] },
    };
    const out = deepScrubStrings(input) as typeof input;
    expect(out.err.spawnargs[0]).toBe('--dbname=postgresql://u:***@h:5432/db');
    expect(out.msg).toBe('ok');
  });

  it('passes non-strings through unchanged', () => {
    expect(deepScrubStrings(42)).toBe(42);
    expect(deepScrubStrings(true)).toBe(true);
    expect(deepScrubStrings(null)).toBe(null);
  });

  it('is cycle-safe', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = deepScrubStrings(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });
});
