import { describe, expect, it, vi } from 'vitest';
import { getBoss, Queue } from './queue';

const boss = vi.hoisted(() => ({
  on: vi.fn(),
  start: vi.fn(async () => {}),
  createQueue: vi.fn<(name: string, options?: object) => Promise<void>>(async () => {}),
  updateQueue: vi.fn<(name: string, options?: object) => Promise<void>>(async () => {}),
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    on = boss.on;
    start = boss.start;
    createQueue = boss.createQueue;
    updateQueue = boss.updateQueue;
  },
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ DATABASE_URL: 'postgresql://x/y' }) }));

function optionsFor(fn: typeof boss.createQueue, name: string): object | undefined {
  return fn.mock.calls.find(([n]) => n === name)?.[1];
}

// getBoss() memoizes on its module-level `bossInstance`, so only the FIRST
// call in this whole file actually reaches PgBoss#createQueue /
// #updateQueue — every later call is a no-op cache hit. Vitest 5 defaults
// `clearMocks: true` (node_modules/vitest/dist/config.cjs), which wipes
// `mock.calls` before EVERY `it`, including ones that never call the mock
// themselves — so splitting the getBoss() boot and its assertions across
// separate `it`s (or a `beforeAll` boot + assertion-only `it`s) loses the
// call history before the first assertion ever runs. Everything therefore
// lives in one `it`, with exactly one real boot.
describe('getBoss queue policy', () => {
  it('applies the queue policy on both createQueue and updateQueue, leaving unlisted queues on defaults', async () => {
    await getBoss();

    expect(boss.createQueue.mock.calls.map(([n]) => n).sort()).toEqual(Object.values(Queue).sort());

    const embedContentPolicy = {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 1800,
    };
    expect(optionsFor(boss.createQueue, Queue.EmbedContent)).toEqual(embedContentPolicy);
    // createQueue is INSERT … ON CONFLICT DO NOTHING. On a database where the
    // queue already exists (every deployment) only updateQueue changes anything.
    expect(optionsFor(boss.updateQueue, Queue.EmbedContent)).toEqual(embedContentPolicy);

    expect(optionsFor(boss.updateQueue, Queue.EmbedBackfill)).toEqual({
      retryLimit: 2,
      retryDelay: 60,
    });

    expect(optionsFor(boss.createQueue, Queue.Thumbnail)).toBeUndefined();
    expect(boss.updateQueue.mock.calls.map(([n]) => n)).not.toContain(Queue.Thumbnail);
  });
});
