import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHeartbeat } from './heartbeat';

afterEach(() => {
  vi.useRealTimers();
});

/** Controllable clock so freshness is deterministic. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createHeartbeat', () => {
  it('is not fresh before the first successful beat', () => {
    const hb = createHeartbeat({ probe: async () => {}, now: () => 0 });
    expect(hb.isFresh()).toBe(false);
    expect(hb.ageMs()).toBeNull();
  });

  it('is fresh immediately after a successful beat', async () => {
    const clock = fakeClock();
    const hb = createHeartbeat({ probe: async () => {}, now: clock.now });
    await hb.beat();
    expect(hb.isFresh()).toBe(true);
    expect(hb.ageMs()).toBe(0);
  });

  it('stays fresh exactly at the staleness threshold', async () => {
    const clock = fakeClock();
    const hb = createHeartbeat({ probe: async () => {}, now: clock.now, staleMs: 1000 });
    await hb.beat();
    clock.advance(1000);
    expect(hb.ageMs()).toBe(1000);
    expect(hb.isFresh()).toBe(true);
  });

  it('goes stale one millisecond past the threshold', async () => {
    const clock = fakeClock();
    const hb = createHeartbeat({ probe: async () => {}, now: clock.now, staleMs: 1000 });
    await hb.beat();
    clock.advance(1001);
    expect(hb.isFresh()).toBe(false);
  });

  // A failing probe must not refresh the timestamp — that is the entire
  // mechanism by which a hung worker eventually reports unhealthy.
  it('does not refresh the timestamp when the probe throws', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('down'));
    const hb = createHeartbeat({ probe, now: clock.now, staleMs: 1000 });

    await hb.beat(); // succeeds at t0
    clock.advance(900);
    await hb.beat(); // fails at t0+900

    // The failure must leave the last success intact: still fresh, and aged
    // from the SUCCESS, not reset and not nulled. This is the assertion that
    // distinguishes the correct design from one where a failed probe clears
    // the timestamp — without it the test passes against both.
    expect(hb.ageMs()).toBe(900);
    expect(hb.isFresh()).toBe(true);

    clock.advance(200); // t0+1100, past staleMs
    expect(hb.isFresh()).toBe(false);
  });

  it('swallows probe rejections rather than throwing', async () => {
    const hb = createHeartbeat({
      probe: async () => {
        throw new Error('boom');
      },
    });
    await expect(hb.beat()).resolves.toBeUndefined();
  });

  it('beats on the interval once started', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(undefined);
    const hb = createHeartbeat({ probe, intervalMs: 1000 });
    hb.start();
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(probe).toHaveBeenCalledTimes(2);
    hb.stop();
  });

  it('start and stop are idempotent', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(undefined);
    const hb = createHeartbeat({ probe, intervalMs: 1000 });
    hb.start();
    hb.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(1);
    hb.stop();
    hb.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while a beat is still in flight', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const hb = createHeartbeat({ probe, intervalMs: 1000 });
    hb.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(probe).toHaveBeenCalledTimes(1);
    release?.();
    hb.stop();
  });
});
