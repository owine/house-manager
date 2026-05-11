// Sentry init MUST run before any other imports so that lib/queue.ts's
// boss.on('error') handler (which calls Sentry.captureException) has a
// live SDK to report through. The DSN gate makes init a no-op when unset.
import * as Sentry from '@sentry/node';
import { getLogger } from '@/lib/logger';
import { startMemoryWatchdog } from '@/lib/observability/memory-watchdog';
import { getBoss, Queue } from '@/lib/queue';
import { ensureSearchIndex } from '@/lib/search/init';
import { APP_GIT_SHA } from '@/lib/version';
import {
  type ClassifyIncomingEmailJob,
  handleClassifyIncomingEmail,
} from './jobs/classify-incoming-email';
import { handleEmbedBackfill } from './jobs/embed-backfill';
import { type EmbedContentJob, handleEmbedContent } from './jobs/embed-content';
import {
  type ExtractAttachmentTextJob,
  handleExtractAttachmentText,
} from './jobs/extract-attachment-text';
import {
  type ExtractIncomingEmailJob,
  handleExtractIncomingEmail,
} from './jobs/extract-incoming-email';
import { handleNotify, type NotifyJob } from './jobs/notify';
import { handleNotifyLogSweep } from './jobs/notify-log-sweep';
import { handlePgDump } from './jobs/pg-dump';
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleSearchIndex, type SearchIndexJob } from './jobs/search-index';
import { handleSearchReindex } from './jobs/search-reindex';
import { handleThumbnail, type ThumbnailJob } from './jobs/thumbnail';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: APP_GIT_SHA,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

const logger = getLogger('worker.lifecycle');

async function main() {
  const boss = await getBoss();

  await boss.work<ThumbnailJob>(Queue.Thumbnail, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleThumbnail(job.data);
    }
  });

  await boss.schedule(Queue.RemindersTick, '*/5 * * * *');
  await boss.work(Queue.RemindersTick, { batchSize: 1 }, async () => {
    await handleRemindersTick({
      enqueue: async (job) => {
        await boss.send(Queue.Notify, job);
      },
    });
  });

  await boss.work<NotifyJob>(Queue.Notify, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handleNotify(job.data, {
        enqueueLater: async (when) => {
          await boss.send(Queue.Notify, job.data, { startAfter: when });
        },
      });
    }
  });

  // Missed-tick recovery: process any reminders that came due during a worker
  // outage. The existing handleRemindersTick scans past-due reminders and the
  // NotificationLog unique constraint deduplicates anything already notified.
  // Failure here is non-fatal: the next scheduled tick (within 5 min) will retry.
  try {
    const result = await handleRemindersTick({
      enqueue: async (job) => {
        await boss.send(Queue.Notify, job);
      },
    });
    logger.info(
      { event: 'startup.tick.recovery', enqueued: result.enqueued },
      'missed-tick recovery complete',
    );
  } catch (e) {
    Sentry.captureException(e);
    logger.error({ err: e }, 'startup tick recovery failed');
    // Do not exit; the next scheduled tick will retry.
  }

  await ensureSearchIndex();

  await boss.work<SearchIndexJob>(Queue.SearchIndex, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handleSearchIndex(job.data);
    }
  });

  await boss.schedule(Queue.SearchReindex, '0 3 * * *');
  await boss.work(Queue.SearchReindex, { batchSize: 1 }, async () => {
    await handleSearchReindex();
  });

  // Notification-log sweeper — runs every 5 min, deletes stale 'queued' rows.
  await boss.schedule(Queue.NotifyLogSweep, '*/5 * * * *');
  await boss.work(Queue.NotifyLogSweep, { batchSize: 1 }, async () => {
    await handleNotifyLogSweep();
  });

  // Postgres logical backup — runs daily at 03:00 UTC.
  await boss.schedule(Queue.PgDump, '0 3 * * *');
  await boss.work(Queue.PgDump, { batchSize: 1 }, async () => {
    await handlePgDump();
  });

  // Inbound-email classifier — fired by the /api/inbound-email webhook handler
  // after each new IncomingEmail row is persisted.
  await boss.work<ClassifyIncomingEmailJob>(
    Queue.ClassifyIncomingEmail,
    { batchSize: 4 },
    handleClassifyIncomingEmail,
  );

  // Inbound-email extractor — pulls cost / date of service / scope from
  // the body via the AI client. Chained from the classify worker (only fires
  // for kinds that benefit: TICKET / INVOICE / ESTIMATE) and re-runnable
  // on demand from the inbox UI. batchSize: 1 because each call is an
  // Anthropic round-trip ~1-3s.
  await boss.work<ExtractIncomingEmailJob>(
    Queue.ExtractIncomingEmail,
    { batchSize: 1 },
    handleExtractIncomingEmail,
  );

  // Ask/RAG vector indexer (Plan 4c) — fired by every entity create / update
  // / archive that produces embeddable content, and by the admin Rebuild +
  // startup backfill paths. `batchSize: 1` so we don't fan out parallel
  // Voyage calls — the free tier is 3 RPM and even paid tiers don't benefit
  // from concurrency given our small per-entity payload.
  await boss.work<EmbedContentJob>(Queue.EmbedContent, { batchSize: 1 }, handleEmbedContent);

  // Attachment text extractor (Plan 4c). Reads each uploaded attachment off
  // disk, dispatches by mime type (unpdf for PDFs, Tesseract for images,
  // direct read for text), writes back `extractedText` + flags, and chains
  // an embed-content job. batchSize: 1 because OCR is heavy.
  await boss.work<ExtractAttachmentTextJob>(
    Queue.ExtractAttachmentText,
    { batchSize: 1 },
    handleExtractAttachmentText,
  );

  // Embedding backfill (Plan 4c). Scans each entity table for rows missing
  // embeddings and enqueues per-entity embed-content jobs. Idempotent.
  // Fired by both the admin Rebuild button and the worker startup recovery
  // below.
  await boss.work(Queue.EmbedBackfill, { batchSize: 1 }, async () => {
    await handleEmbedBackfill();
  });

  // Startup backfill — fire-and-forget a one-shot embed-backfill at every
  // boot. The handler itself is a no-op when ASK_ENABLED=false, so this is
  // safe to run unconditionally. Failure is non-fatal: the admin Rebuild
  // button is the manual recovery path.
  try {
    await boss.send(Queue.EmbedBackfill, {});
    logger.info({ event: 'startup.embed-backfill.kicked' }, 'embed-backfill enqueued');
  } catch (e) {
    Sentry.captureException(e);
    logger.error({ err: e }, 'startup embed-backfill enqueue failed');
  }

  // Memory watchdog (Plan 4c) — Tesseract.js + Voyage batching can push the
  // worker container above its implicit memory budget on a Pi. The watchdog
  // logs a structured warning when RSS crosses 800 MB; Sentry picks it up
  // through the Plan 5a integration.
  startMemoryWatchdog({ thresholdMb: 800, intervalMs: 60_000 });

  logger.info(
    'registered thumbnail, reminders.tick + notify, search.index + search.reindex, pg-dump, notify-log.sweep, incoming-email.classify, incoming-email.extract, embed.content, embed.backfill, attachment.extract-text jobs',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'received shutdown signal');
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  const onSignal = (signal: string) => {
    shutdown(signal).catch((e) => {
      logger.error({ err: e }, 'shutdown failed');
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

main().catch((e) => {
  Sentry.captureException(e);
  logger.error({ err: e }, 'failed to start');
  process.exit(1);
});
