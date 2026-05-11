import { getLogger } from '@/lib/logger';

const log = getLogger('worker.memory');

export type MemoryWatchdogOptions = {
  /** RSS threshold in megabytes. */
  thresholdMb: number;
  /** Sample interval in milliseconds. */
  intervalMs: number;
};

/**
 * Periodic RSS-memory watchdog for the worker process. When `process.memoryUsage().rss`
 * crosses `thresholdMb`, emit a structured `module: 'worker.memory'` warning.
 * The Plan 5a Pino+Sentry pipeline picks the warning up; from there it surfaces
 * in logs and (if Sentry is configured) creates a breadcrumb event.
 *
 * The watchdog never kills the process — that's the caller's policy. Its job
 * is purely observation so memory creep is visible before the host actually
 * OOMs. Plan 4c uses 800MB as the alert level for the Pi-class worker, which
 * sits well below typical 1–2 GB headroom for a tesseract.js + Voyage payload.
 *
 * Returns a `stop()` function that clears the interval. Idempotent — calling
 * stop multiple times is safe.
 */
export function startMemoryWatchdog(opts: MemoryWatchdogOptions): () => void {
  const thresholdBytes = opts.thresholdMb * 1024 * 1024;
  let lastWarnedAt = 0;
  // Don't spam: at most one warn per 5 minutes even if RSS stays high.
  const COOLDOWN_MS = 5 * 60 * 1000;

  const timer = setInterval(() => {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    if (rss < thresholdBytes) return;
    const now = Date.now();
    if (now - lastWarnedAt < COOLDOWN_MS) return;
    lastWarnedAt = now;
    log.warn(
      {
        rssMb: Math.round(rss / 1024 / 1024),
        heapUsedMb: Math.round(heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(heapTotal / 1024 / 1024),
        thresholdMb: opts.thresholdMb,
      },
      'worker memory above threshold',
    );
  }, opts.intervalMs);
  // Don't keep the event loop alive just for the watchdog; the worker has
  // its own lifecycle.
  timer.unref();

  return () => clearInterval(timer);
}
