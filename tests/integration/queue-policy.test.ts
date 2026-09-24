import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, stopStack, type TestStack } from './setup';

/**
 * Proves the A-M2 fix against a REAL pg-boss, not the mocked unit test in
 * `lib/queue.test.ts`. `createQueue` is `INSERT … ON CONFLICT DO NOTHING`
 * (pg-boss `plans.js`), so a policy passed only to `createQueue` is silently
 * ignored on any database where the queue already exists — which is every
 * real deployment. This test simulates that: it creates `embed.content`
 * with NO policy first (a stand-in for a pre-existing prod database), then
 * runs the app's `getBoss()` and checks the policy actually landed via
 * `getQueue()`. `lib/queue.ts`'s `updateQueue` call is what makes that work;
 * without it this test fails the same way the unit test does.
 *
 * No Prisma/Meilisearch needed — pg-boss owns its own `pgboss` schema — so
 * this uses the lighter `startStack`/`stopStack` (see `tests/integration/
 * health.test.ts`) rather than `setupIntegration`, which also runs a full
 * Prisma migrate and starts Meilisearch.
 *
 * `@/lib/env` is intentionally NOT mocked: `getBoss()` reads `DATABASE_URL`
 * via `getEnv()`, and pointing it at the container requires setting
 * `process.env.DATABASE_URL` and letting the real (lazy) `getEnv()` read it.
 * The other required vars come from `.env` locally (`vitest.env.ts`
 * `dotenvFallbacks`) and from CI's job-level env (`.github/workflows/ci.yml`).
 */

let stack: TestStack;
const bosses: PgBoss[] = [];

async function trackedBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString });
  bosses.push(boss);
  return boss;
}

beforeAll(async () => {
  stack = await startStack();
  process.env.DATABASE_URL = stack.databaseUrl;
}, 120_000);

afterAll(async () => {
  // Stop every PgBoss instance this file started, whether or not the test
  // body reached its own cleanup, so nothing leaks a connection past the
  // container teardown.
  await Promise.all(bosses.map((boss) => boss.stop().catch(() => {})));
  await stopStack(stack);
});

describe('getBoss applies its queue policy to a pre-existing database', () => {
  it('reaches embed.content and embed.backfill via updateQueue, and leaves other queues on defaults', async () => {
    // Simulate a prod database where `embed.content` already exists with
    // whatever pg-boss defaults it was created under, before this fix ever
    // ran. createQueue with no options is exactly what the pre-fix
    // `lib/queue.ts` did.
    const preexisting = await trackedBoss(stack.databaseUrl);
    await preexisting.start();
    await preexisting.createQueue('embed.content');
    await preexisting.stop();

    // The app's real init path — unmocked, against the same database.
    const { getBoss, Queue } = await import('@/lib/queue');
    const appBoss = await getBoss();
    bosses.push(appBoss);

    const embedContent = await appBoss.getQueue(Queue.EmbedContent);
    expect(embedContent).toMatchObject({
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 1800,
    });

    const embedBackfill = await appBoss.getQueue(Queue.EmbedBackfill);
    expect(embedBackfill).toMatchObject({
      retryLimit: 2,
      retryDelay: 60,
    });

    // A queue not in QUEUE_POLICY keeps pg-boss's own defaults: 2 retries,
    // 0s delay, no backoff, 900s (15 min) expiry.
    const thumbnail = await appBoss.getQueue(Queue.Thumbnail);
    expect(thumbnail).toMatchObject({
      retryLimit: 2,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 900,
    });
  });
});
