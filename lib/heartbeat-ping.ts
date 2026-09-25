import { getLogger } from '@/lib/logger';

// Dead-man pings for scheduled jobs: after a successful run, GET a push URL
// (a HetrixTools Cron Job monitor, healthchecks.io, ...). The monitor alerts when
// the pings STOP, so a job that fails, hangs, or is never scheduled goes red
// by silence rather than by anything this process has to remember to send.
//
// Not to be confused with worker/heartbeat.ts, which is the worker's liveness
// beat for its own /api/health endpoint.

const logger = getLogger('heartbeat');

export const HEARTBEAT_TIMEOUT_MS = 10_000;

export type HeartbeatResult = 'sent' | 'skipped' | 'failed';

export type HeartbeatOptions = {
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Abort the GET after this long. Defaults to HEARTBEAT_TIMEOUT_MS. */
  timeoutMs?: number;
};

/**
 * GET `url` once. Fail-soft: a monitor outage must never fail the job, and a
 * missed ping is exactly what the monitor alerts on.
 *
 * `name` prefixes the log event (`<name>.heartbeat.failed`), so each job's
 * failures stay distinguishable in the logs.
 *
 * Never logs the URL, and never logs an error's `message`: undici puts the full
 * request URL in some of its errors, and this URL carries the push token (and
 * could carry `user:pass@` — httpUrlSchema allows credentials). Only the error's
 * name and its cause's `code` (e.g. ECONNREFUSED, ENOTFOUND) are logged.
 */
export async function pingHeartbeat(
  name: string,
  url: string | undefined,
  opts: HeartbeatOptions = {},
): Promise<HeartbeatResult> {
  if (!url) return 'skipped';
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? HEARTBEAT_TIMEOUT_MS),
    });
    // Release the connection. An unread body pins the socket until GC, and
    // reminders.tick pings every five minutes.
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) {
      logger.warn(
        { event: `${name}.heartbeat.failed`, status: res.status },
        'heartbeat rejected (non-fatal)',
      );
      return 'failed';
    }
    return 'sent';
  } catch (e) {
    const err = e as Error;
    logger.warn(
      {
        event: `${name}.heartbeat.failed`,
        errName: err.name,
        causeCode: (err.cause as { code?: string } | undefined)?.code,
      },
      'heartbeat failed (non-fatal)',
    );
    return 'failed';
  }
}

/**
 * Run a scheduled job, then ping. The ping happens only when `run` resolves:
 * if it throws, the error propagates (so pg-boss records the failure and
 * retries) and no ping is sent. The ping itself never throws.
 */
export async function withHeartbeat<T>(
  name: string,
  url: string | undefined,
  run: () => Promise<T>,
  opts: HeartbeatOptions = {},
): Promise<T> {
  const result = await run();
  await pingHeartbeat(name, url, opts);
  return result;
}
