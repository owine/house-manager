import { getLogger } from '@/lib/logger';

const log = getLogger('worker.heartbeat');

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 120_000;

export type Heartbeat = {
  /** Start the interval. Idempotent. */
  start: () => void;
  /** Clear the interval. Idempotent. */
  stop: () => void;
  /** Run one beat now. Never rejects. */
  beat: () => Promise<void>;
  /** Milliseconds since the last *successful* beat, or null if none yet. */
  ageMs: () => number | null;
  /** A beat has landed and it is no older than `staleMs`. */
  isFresh: () => boolean;
};

export type HeartbeatOptions = {
  /** Liveness probe. Rejecting means "not alive"; the result is ignored. */
  probe: () => Promise<unknown>;
  intervalMs?: number;
  staleMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

/**
 * Tracks whether the worker is still able to service its queue.
 *
 * Driven by an interval rather than by job completions on purpose: the ticks
 * are five minutes apart at best and an idle house can go hours without any
 * work at all, so a job-driven heartbeat would report a perfectly healthy
 * worker as stale. The interval asks the narrower question — *can this
 * process still reach the queue* — independent of whether there is work.
 */
export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const now = opts.now ?? Date.now;

  let lastOkAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const beat = async (): Promise<void> => {
    // A probe that never settles is exactly the failure mode this heartbeat
    // exists to detect. Without this guard every tick would stack another
    // concurrent probe on top of the wedged one. Skipping instead means
    // `lastOkAt` simply stops advancing and freshness decays to stale —
    // which is the correct report.
    if (inFlight) return;
    inFlight = true;
    try {
      await opts.probe();
      lastOkAt = now();
    } catch (e) {
      // Deliberately does not clear `lastOkAt`: freshness decays with time
      // rather than flipping on a single blip.
      log.warn({ err: e }, 'worker heartbeat probe failed');
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void beat(), intervalMs);
      // Never hold the event loop open for the heartbeat — the worker has its
      // own lifecycle, and an un-unref'd timer turns shutdown into a hang.
      timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    beat,
    ageMs: () => (lastOkAt === null ? null : now() - lastOkAt),
    isFresh: () => lastOkAt !== null && now() - lastOkAt <= staleMs,
  };
}
