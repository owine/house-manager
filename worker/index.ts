// Sentry init MUST run before any other imports so that lib/queue.ts's
// boss.on('error') handler (which calls Sentry.captureException) has a
// live SDK to report through. The DSN gate makes init a no-op when unset.
import * as Sentry from '@sentry/node';
import { getLogger } from '@/lib/logger';
import { getBoss, Queue } from '@/lib/queue';
import { ensureSearchIndex } from '@/lib/search/init';
import { APP_GIT_SHA } from '@/lib/version';
import {
  type ClassifyIncomingEmailJob,
  handleClassifyIncomingEmail,
} from './jobs/classify-incoming-email';
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
  // after each new IncomingEmail row is persisted. Stub until Phase D.
  await boss.work<ClassifyIncomingEmailJob>(
    Queue.ClassifyIncomingEmail,
    { batchSize: 4 },
    handleClassifyIncomingEmail,
  );

  logger.info(
    'registered thumbnail, reminders.tick + notify, search.index + search.reindex, pg-dump, notify-log.sweep, incoming-email.classify jobs',
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
