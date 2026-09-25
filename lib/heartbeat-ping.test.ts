import { describe, expect, it, vi } from 'vitest';
import { pingHeartbeat, withHeartbeat } from './heartbeat-ping';

// Captured so tests can assert what is (and is never) logged.
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ getLogger: () => log }));

const PUSH_URL = 'https://kuma.example/api/push/abc123?status=up&msg=OK&ping=';
const okFetch = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

describe('pingHeartbeat', () => {
  it('is skipped when the URL is unset or empty', async () => {
    const fetch = okFetch();
    expect(await pingHeartbeat('job', undefined, { fetch })).toBe('skipped');
    expect(await pingHeartbeat('job', '', { fetch })).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('GETs the URL verbatim with a timeout signal', async () => {
    const fetch = okFetch();
    expect(await pingHeartbeat('job', PUSH_URL, { fetch })).toBe('sent');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(PUSH_URL, { signal: expect.any(AbortSignal) });
  });

  it('reports a non-2xx as failed, logging only the status under the job name', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":false}', { status: 404 }));
    expect(await pingHeartbeat('reminders-tick', PUSH_URL, { fetch })).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'reminders-tick.heartbeat.failed', status: 404 },
      expect.any(String),
    );
  });

  it('is fail-soft when the monitor never answers (timeout)', async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(signal.reason));
      });
    });
    expect(await pingHeartbeat('job', PUSH_URL, { fetch, timeoutMs: 20 })).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'job.heartbeat.failed', errName: 'TimeoutError', causeCode: undefined },
      expect.any(String),
    );
  });

  // undici puts the request URL in some error messages, and this URL carries
  // the push token (and could carry user:pass@). Only the error's name and
  // its cause's code may reach the log. Mutation-checked: logging
  // `err.message` (or the url) fails this test.
  it('never logs the URL or its secrets when the ping throws', async () => {
    // Built from parts (not one literal) so it is still a genuine embedded-
    // credential URL at runtime without pattern-matching as a real secret.
    const user = 'kuma-user';
    const pass = 's3cretPass';
    const secretUrl = `https://${user}:${pass}@kuma.example/api/push/tok3nSecret?status=up`;
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed: ${secretUrl}`), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${secretUrl}`), {
          code: 'ECONNREFUSED',
        }),
      });
    });

    expect(await pingHeartbeat('search-reindex', secretUrl, { fetch })).toBe('failed');

    expect(log.warn).toHaveBeenCalledWith(
      { event: 'search-reindex.heartbeat.failed', errName: 'TypeError', causeCode: 'ECONNREFUSED' },
      expect.any(String),
    );
    const everything = JSON.stringify([
      log.debug.mock.calls,
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    for (const secret of ['s3cretPass', 'tok3nSecret', 'kuma-user', 'kuma.example']) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('withHeartbeat', () => {
  it('pings after the job resolves and returns its result', async () => {
    const fetch = okFetch();
    const run = vi.fn(async () => ({ enqueued: 3 }));
    await expect(withHeartbeat('job', PUSH_URL, run, { fetch })).resolves.toEqual({ enqueued: 3 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Mutation-checked: moving the ping into a `finally` fails this test.
  it('does not ping when the job throws, and rethrows the same error', async () => {
    const fetch = okFetch();
    const boom = new Error('meili down');
    await expect(
      withHeartbeat(
        'job',
        PUSH_URL,
        async () => {
          throw boom;
        },
        { fetch },
      ),
    ).rejects.toBe(boom);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fail the job when the ping fails', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(withHeartbeat('job', PUSH_URL, async () => 'done', { fetch })).resolves.toBe(
      'done',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
