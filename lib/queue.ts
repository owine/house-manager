import { PgBoss } from 'pg-boss';

import { getEnv } from '@/lib/env';

// Every queue used by `boss.send()` or `boss.work()` must be registered.
// pg-boss 10+ no longer auto-creates queues on first use; calling send/work
// against an unregistered queue throws "Queue X does not exist". `createQueue`
// is idempotent, so we call it for the full set during `getBoss()` startup.
const QUEUES = ['thumbnail'] as const;

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const env = getEnv();
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (e) => console.error('pg-boss error', e));
  await boss.start();
  for (const name of QUEUES) await boss.createQueue(name);
  bossInstance = boss;
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true });
    bossInstance = null;
  }
}
