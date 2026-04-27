import { PgBoss } from 'pg-boss';

import { getEnv } from '@/lib/env';

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const env = getEnv();
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (e) => console.error('pg-boss error', e));
  await boss.start();
  bossInstance = boss;
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true });
    bossInstance = null;
  }
}
