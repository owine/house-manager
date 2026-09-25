import { describe, expect, it, vi } from 'vitest';
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleSearchReindex } from './jobs/search-reindex';
import { runRemindersTick, runSearchReindex } from './monitored-jobs';

// Only the two fields monitored-jobs reads.
const env = vi.hoisted(() => ({
  REMINDERS_TICK_HEARTBEAT_URL: 'https://kuma.example/api/push/tick?status=up' as
    | string
    | undefined,
  SEARCH_REINDEX_HEARTBEAT_URL: 'https://kuma.example/api/push/reindex?status=up' as
    | string
    | undefined,
}));
vi.mock('@/lib/env', () => ({ getEnv: () => env }));
vi.mock('@/lib/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// The handlers need Postgres and Meilisearch; their own behaviour is covered
// by tests/integration/reminders-tick.test.ts and search-reindex.test.ts.
vi.mock('./jobs/reminders-tick', () => ({ handleRemindersTick: vi.fn() }));
vi.mock('./jobs/search-reindex', () => ({ handleSearchReindex: vi.fn() }));

const okFetch = () => vi.fn(async () => new Response('ok', { status: 200 }));
const enqueue = async () => {};

describe('runRemindersTick', () => {
  it('runs the tick with the given deps, then pings its own URL once', async () => {
    vi.mocked(handleRemindersTick).mockResolvedValueOnce({ enqueued: 2 });
    const fetch = okFetch();

    await expect(runRemindersTick({ enqueue }, { fetch })).resolves.toEqual({ enqueued: 2 });

    expect(handleRemindersTick).toHaveBeenCalledWith({ enqueue });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(env.REMINDERS_TICK_HEARTBEAT_URL, {
      signal: expect.any(AbortSignal),
    });
  });

  it('does not ping when the tick throws, and rethrows for pg-boss', async () => {
    const boom = new Error('db down');
    vi.mocked(handleRemindersTick).mockRejectedValueOnce(boom);
    const fetch = okFetch();

    await expect(runRemindersTick({ enqueue }, { fetch })).rejects.toBe(boom);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs without pinging when the URL is unset', async () => {
    const saved = env.REMINDERS_TICK_HEARTBEAT_URL;
    env.REMINDERS_TICK_HEARTBEAT_URL = undefined;
    try {
      vi.mocked(handleRemindersTick).mockResolvedValueOnce({ enqueued: 0 });
      const fetch = okFetch();
      await expect(runRemindersTick({ enqueue }, { fetch })).resolves.toEqual({ enqueued: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      env.REMINDERS_TICK_HEARTBEAT_URL = saved;
    }
  });
});

describe('runSearchReindex', () => {
  it('reindexes, then pings its own URL (not the tick URL) once', async () => {
    vi.mocked(handleSearchReindex).mockResolvedValueOnce({ processed: 5, lastTaskUid: 9 });
    const fetch = okFetch();

    await expect(runSearchReindex({ fetch })).resolves.toEqual({ processed: 5, lastTaskUid: 9 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(env.SEARCH_REINDEX_HEARTBEAT_URL, {
      signal: expect.any(AbortSignal),
    });
  });

  it('does not ping when the reindex throws', async () => {
    const boom = new Error('meili down');
    vi.mocked(handleSearchReindex).mockRejectedValueOnce(boom);
    const fetch = okFetch();

    await expect(runSearchReindex({ fetch })).rejects.toBe(boom);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still resolves when the monitor is down', async () => {
    vi.mocked(handleSearchReindex).mockResolvedValueOnce({ processed: 0, lastTaskUid: null });
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(runSearchReindex({ fetch })).resolves.toEqual({
      processed: 0,
      lastTaskUid: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
