import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const query = vi.fn();
const end = vi.fn();
const clientConstructorArgs: unknown[] = [];

vi.mock('pg', () => ({
  Client: class {
    connect = connect;
    query = query;
    end = end;
    constructor(opts: unknown) {
      clientConstructorArgs.push(opts);
    }
  },
}));

import { checkHealth, isReady, probeDatabase } from './health';

const OPTS = { databaseUrl: 'postgresql://x/y', meiliUrl: 'http://meili:7700' };

beforeEach(() => {
  connect.mockReset().mockResolvedValue(undefined);
  query.mockReset().mockResolvedValue({ rows: [] });
  end.mockReset().mockResolvedValue(undefined);
  clientConstructorArgs.length = 0;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkHealth', () => {
  it('is ok when both dependencies answer', async () => {
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ database: 'ok', meilisearch: 'ok' });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('is down when the database is unreachable', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('down');
    expect(result.checks.database).toContain('ECONNREFUSED');
  });

  // The whole point of this contract: search degrades, it does not page.
  it('stays ok when meilisearch is unreachable, but reports it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
    expect(result.checks.meilisearch).toContain('ECONNREFUSED');
  });

  it('reports a non-2xx meilisearch response without failing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response));
    const result = await checkHealth(OPTS);
    expect(result.status).toBe('ok');
    expect(result.checks.meilisearch).toBe('error: HTTP 503');
  });

  it('closes the connection even when the query throws', async () => {
    query.mockRejectedValue(new Error('boom'));
    await checkHealth(OPTS);
    expect(end).toHaveBeenCalledTimes(1);
  });

  // The mocked `pg` Client here doesn't implement timeouts itself — a stalled
  // real query never resolves in this test either way, so we can't observe a
  // timeout firing. What we CAN assert honestly is that probeDatabase asks
  // node-postgres to enforce one, client-side and server-side, on every
  // connection it opens. That's the actual guarantee against the "handshake
  // succeeds, then the query hangs" failure mode from PR review.
  it('constructs the pg Client with a bounded query timeout', async () => {
    await probeDatabase(OPTS.databaseUrl);
    expect(clientConstructorArgs[0]).toMatchObject({
      query_timeout: 2000,
      statement_timeout: 2000,
    });
  });
});

describe('isReady', () => {
  it('is ready when both dependencies answer', async () => {
    await expect(isReady(OPTS)).resolves.toMatchObject({ ready: true });
  });

  // Guards the refactor: isReady must NOT inherit checkHealth's looser contract.
  it('is not ready when meilisearch is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await isReady(OPTS);
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe('ok');
  });

  it('is not ready when the database is unreachable', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(isReady(OPTS)).resolves.toMatchObject({ ready: false });
  });
});
