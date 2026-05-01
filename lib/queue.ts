import { PgBoss } from 'pg-boss';

import { getEnv } from '@/lib/env';

// Single source of truth for queue names. Producers (boss.send) and consumers
// (boss.work) import `Queue.X` instead of repeating string literals — adding a
// new queue is exactly one line here and the registration loop below picks it
// up automatically. pg-boss 10+ requires explicit createQueue() before any
// send/work; createQueue is idempotent.
export const Queue = {
  Thumbnail: 'thumbnail',
  RemindersTick: 'reminders.tick',
  Notify: 'notify',
} as const;
export type QueueName = (typeof Queue)[keyof typeof Queue];
const QUEUES = Object.values(Queue) as readonly QueueName[];

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
