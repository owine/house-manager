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

  it('masks the capability token in the calendar and inbound-email routes', () => {
    expect(scrubSecrets('GET /api/calendar/9f8e7d6c5b4a.ics')).toBe('GET /api/calendar/***');
    expect(scrubSecrets('https://hm.example/api/inbound-email/abcDEF123456?x=1')).toBe(
      'https://hm.example/api/inbound-email/***?x=1',
    );
    // Other routes, and the bare prefix, are left alone.
    expect(scrubSecrets('/api/files/abc123')).toBe('/api/files/abc123');
    expect(scrubSecrets('/api/calendar/')).toBe('/api/calendar/');
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

  // Only object cycles were guarded; a self-referencing array recursed
  // forever. Affects the Pino path too (an array field can hold itself).
  it('is cycle-safe for a self-referencing array', () => {
    const a: unknown[] = ['x'];
    a.push(a);
    const out = deepScrubStrings(a) as unknown[];
    expect(out[0]).toBe('x');
    expect(out[1]).toBe('[Circular]');
  });

  // `seen` must track the current recursion ANCESTRY, not every value ever
  // visited: a `seen.add` with no matching removal turns a shared but
  // non-cyclic reference into a false "[Circular]" the second time it's
  // reached from an unrelated branch — a real regression this repo shipped
  // (a log line with `{ ids, again: ids }` logged `again: "[Circular]"`).
  // Mutation-checked: deleting `seen.delete(value)` after the array recurse
  // fails this.
  it('walks a shared (non-cyclic) array twice, keeping its content both times', () => {
    const ids = ['a', 'b'];
    const out = deepScrubStrings({ ids, again: ids }) as { ids: unknown; again: unknown };
    expect(out.again).toEqual(['a', 'b']);
    expect(out.ids).toEqual(['a', 'b']);
  });

  it('walks a shared (non-cyclic) object twice, keeping its content both times', () => {
    const shared = { host: 'db-host', url: 'postgresql://u:p4ss@h/db' };
    const out = deepScrubStrings({ first: shared, second: shared }) as {
      first: { url: string };
      second: { url: string };
    };
    expect(out.first.url).toBe('postgresql://u:***@h/db');
    expect(out.second.url).toBe('postgresql://u:***@h/db');
  });

  it('still detects a true cycle through a shared array (ancestor, not just visited)', () => {
    const inner: unknown[] = ['x'];
    const outer = { a: inner, b: inner };
    inner.push(outer); // inner -> outer -> inner: a real cycle
    const out = deepScrubStrings(outer) as { a: unknown[]; b: unknown };
    expect(out.a[0]).toBe('x');
    expect(out.a[1]).toBe('[Circular]');
  });
});

describe('deepScrubStrings is linear-time', () => {
  // The userinfo-password pattern was quadratic on a long run of scheme-charset
  // characters that never resolves to "://" (a. -> credentials never found).
  // 'a.'.repeat(50_000) took ~8s before the fix; must stay well under the
  // 250ms budget now. Mutation-checked: reverting the widened lookbehind in
  // lib/log-scrub.ts's userinfo pattern fails this.
  it('scrubs a 100KB adversarial string in well under a second', () => {
    const adversarial = 'a.'.repeat(50_000);
    const t0 = performance.now();
    deepScrubStrings(adversarial);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
