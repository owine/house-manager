import * as Sentry from '@sentry/node';
import { PgBoss, type QueueOptions } from 'pg-boss';

import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';

const logger = getLogger('queue');

// Single source of truth for queue names. Producers (boss.send) and consumers
// (boss.work) import `Queue.X` instead of repeating string literals — adding a
// new queue is exactly one line here and the registration loop below picks it
// up automatically. pg-boss 10+ requires explicit createQueue() before any
// send/work; createQueue is idempotent.
export const Queue = {
  Thumbnail: 'thumbnail',
  RemindersTick: 'reminders.tick',
  Notify: 'notify',
  SearchIndex: 'search.index',
  SearchReindex: 'search.reindex',
  PgDump: 'pg-dump', // NEW
  NotifyLogSweep: 'notify-log.sweep', // NEW
  DigestTick: 'digest.tick',
  ClassifyIncomingEmail: 'incoming-email.classify',
  EmbedContent: 'embed.content',
  EmbedBackfill: 'embed.backfill',
  ExtractAttachmentText: 'attachment.extract-text',
  ChoreAutoCompleteTick: 'chore-auto-complete.tick',
} as const;
type QueueName = (typeof Queue)[keyof typeof Queue];
const QUEUES = Object.values(Queue) as readonly QueueName[];

// Per-queue retry policy. A queue not listed here runs on pg-boss's defaults:
// 2 retries, 0s delay, no backoff. That is fine for idempotent ticks and useless
// against a rate-limited external API.
const QUEUE_POLICY: Partial<Record<QueueName, QueueOptions>> = {
  // A Voyage outage or a 429 storm outlasts two immediate retries. Backoff runs
  // 5 retries over roughly 15-30 min (30s·2^n with jitter, each gap capped at
  // 15 min). After that the job fails, and the nightly embed.backfill stale
  // scan re-enqueues it.
  //
  // Expiry is sized to one attempt's real worst case, not the 15-min default.
  // embedTexts posts batches of 128 chunks sequentially, and one batch can
  // spend 6 requests × 30s timeout plus 5 inline 429 sleeps × 60s, about 8 min.
  // The largest source is an attachment capped at 256K chars of extracted text
  // (extract-attachment-text.ts), which is about 145 chunks at ~450 net tokens
  // each, so 2 batches and about 16 min. That is already past the default 900s,
  // so an attempt could expire mid-embed and be retried from scratch. 30 min
  // covers two batches plus DB work with margin.
  [Queue.EmbedContent]: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 1800,
  },
  // DB-only work, so a failure is a Postgres blip. Give it a minute, not 0s.
  [Queue.EmbedBackfill]: { retryLimit: 2, retryDelay: 60 },
};

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const env = getEnv();
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (e) => {
    Sentry.captureException(e);
    logger.error({ err: e }, 'pg-boss error');
  });
  await boss.start();
  for (const name of QUEUES) {
    const policy = QUEUE_POLICY[name];
    await boss.createQueue(name, policy);
    // createQueue is `INSERT … ON CONFLICT DO NOTHING` (pg-boss plans.js). On
    // any database where the queue already exists it changes nothing, so a
    // policy passed only there would never reach production. updateQueue
    // applies it and is idempotent. Jobs snapshot the policy at send().
    if (policy) await boss.updateQueue(name, policy);
  }
  bossInstance = boss;
  return boss;
}
