import { getBoss } from '@/lib/queue';
import { handleThumbnail, type ThumbnailJob } from './jobs/thumbnail';

async function main() {
  const boss = await getBoss();

  await boss.work<ThumbnailJob>('thumbnail', { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleThumbnail(job.data);
    }
  });
  console.log('worker: registered thumbnail job');

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
