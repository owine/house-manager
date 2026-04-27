import { getBoss } from '@/lib/queue';

async function main() {
  const boss = await getBoss();
  console.log('worker: pg-boss started; no jobs registered yet (Plan 1 placeholder)');

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
