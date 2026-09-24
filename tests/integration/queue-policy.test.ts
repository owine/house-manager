import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startStack, stopStack, type TestStack } from './setup';

// getBoss() reads only DATABASE_URL. Mock getEnv to exactly that, like every
// other integration file: the real getEnv() validates the WHOLE schema, which
// passes locally only because .env fills the gaps. CI sets no such vars for
// this job, so the unmocked version failed there ("expected string, received
// undefined"). Read lazily so beforeAll can point it at the container.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ DATABASE_URL: process.env.DATABASE_URL }),
}));

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
 * `@/lib/env` is mocked to return only `DATABASE_URL` (see the `vi.mock`
 * above), which `beforeAll` points at the container.
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
