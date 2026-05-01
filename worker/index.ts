import { getBoss, Queue } from '@/lib/queue';
import { ensureSearchIndex } from '@/lib/search/init';
import { handleNotify, type NotifyJob } from './jobs/notify';
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleSearchIndex, type SearchIndexJob } from './jobs/search-index';
import { handleSearchReindex } from './jobs/search-reindex';
import { handleThumbnail, type ThumbnailJob } from './jobs/thumbnail';

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

  console.log(
    'worker: registered thumbnail, reminders.tick + notify, search.index + search.reindex jobs',
  );

  const shutdown = async (signal: string) => {
    console.log(`worker: received ${signal}, shutting down...`);
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  const onSignal = (signal: string) => {
    shutdown(signal).catch((e) => {
      console.error('worker: shutdown failed', e);
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

main().catch((e) => {
  console.error('worker failed to start', e);
  process.exit(1);
});
