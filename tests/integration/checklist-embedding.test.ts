import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/search/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/search/client')>();
  return { ...orig, enqueueSearchIndex: vi.fn(async () => 'job-id') };
});

// Capture what reaches pg-boss. Deliberately NOT mocking @/lib/embedding/enqueue:
// the ASK_ENABLED gate lives inside it (same reasoning as parts-embedding.test.ts).
const enqueued: Array<{ queue: string; data: unknown }> = [];
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({
      send: vi.fn(async (queue: string, data: unknown) => {
        enqueued.push({ queue, data });
        return 'fake-job-id';
      }),
    })),
  };
});

// Never call Voyage. The texts are captured so a test can prove the embedded
// status/name actually changed.
const embeddedTexts: string[][] = [];
vi.mock('@/lib/embedding/voyage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/embedding/voyage')>();
  return {
    ...orig,
    embedTexts: vi.fn(async (texts: string[]) => {
      embeddedTexts.push(texts);
      return texts.map(() => new Array(1024).fill(0.001));
    }),
  };
});

type EmbedJob = { entityType: EmbeddingEntityType; entityId: string };

function embedJobs(): EmbedJob[] {
  return enqueued.filter((e) => e.queue === 'embed.content').map((e) => e.data as EmbedJob);
}

function checklistItemJobIds(): string[] {
  return embedJobs()
    .filter((j) => j.entityType === 'CHECKLIST_ITEM')
    .map((j) => j.entityId);
}

let ctx: IntegrationContext;
let actions: typeof import('@/lib/checklists/actions');
let suggest: typeof import('@/lib/ai/suggest/checklist');
let embedding: typeof import('@/lib/embedding');

/** Play the captured jobs through the real consumer, as the worker would. */
async function runEmbedJobs(): Promise<void> {
  for (const job of embedJobs()) await embedding.embedEntity(job.entityType, job.entityId);
}

async function embeddingCount(checklistItemId: string): Promise<number> {
  return ctx.prisma.embedding.count({
    where: { entityType: 'CHECKLIST_ITEM', entityId: checklistItemId },
  });
}

async function checklistWith(titles: string[]) {
  const checklist = await ctx.prisma.checklist.create({ data: { name: 'Spring prep' } });
  const items = await Promise.all(
    titles.map((title, position) =>
      ctx.prisma.checklistItem.create({ data: { checklistId: checklist.id, title, position } }),
    ),
  );
  return { checklist, items };
}

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/checklists/actions');
  suggest = await import('@/lib/ai/suggest/checklist');
  embedding = await import('@/lib/embedding');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
  delete process.env.ASK_ENABLED;
});

beforeEach(async () => {
  enqueued.length = 0;
  embeddedTexts.length = 0;
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  await ctx.prisma.aISuggestionLog.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@x', name: 'Test' } });
});

describe('checklist mutations enqueue CHECKLIST_ITEM by ChecklistItem.id (Q-H1)', () => {
  it('createChecklist enqueues nothing — a new checklist has no items', async () => {
    const r = await actions.createChecklist({ name: 'Empty' });
    expect(r.ok).toBe(true);
    expect(checklistItemJobIds()).toEqual([]);
  });

  it('addChecklistItem enqueues the new item, and the job embeds it', async () => {
    const { checklist } = await checklistWith([]);
    const r = await actions.addChecklistItem({
      checklistId: checklist.id,
      title: 'Flush water heater',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checklistItemJobIds()).toEqual([r.data.id]);

    await runEmbedJobs();
    expect(await embeddingCount(r.data.id)).toBeGreaterThan(0);
    expect(embeddedTexts.flat().join('\n')).toContain('Item: Flush water heater');
  });

  it('toggleChecklistItem re-enqueues the item — completion status is embedded', async () => {
    const { items } = await checklistWith(['Clean gutters']);
    const [ci] = items;
    if (!ci) throw new Error('fixture');

    const r = await actions.toggleChecklistItem({ id: ci.id, done: true });
    expect(r.ok).toBe(true);
    expect(checklistItemJobIds()).toEqual([ci.id]);

    await runEmbedJobs();
    expect(embeddedTexts.flat().join('\n')).toContain('Status: completed');
  });

  it('resetChecklist re-enqueues exactly the items it un-completed', async () => {
    const { checklist, items } = await checklistWith(['A', 'B', 'C']);
    const done = items.slice(0, 2).map((i) => i.id);
    await ctx.prisma.checklistItem.updateMany({
      where: { id: { in: done } },
      data: { completedAt: new Date() },
    });

    await actions.resetChecklist({ id: checklist.id });
    expect(checklistItemJobIds().sort()).toEqual([...done].sort());
  });

  it('updateChecklist re-enqueues every item — the checklist name is embedded', async () => {
    const { checklist, items } = await checklistWith(['A', 'B']);
    await actions.updateChecklist({ id: checklist.id, name: 'Fall prep' });
    expect(checklistItemJobIds().sort()).toEqual(items.map((i) => i.id).sort());

    await runEmbedJobs();
    expect(embeddedTexts.flat().join('\n')).toContain('Checklist: Fall prep');
  });

  it('reorderChecklistItems enqueues nothing — position is not embedded', async () => {
    const { checklist, items } = await checklistWith(['A', 'B']);
    await actions.reorderChecklistItems({
      checklistId: checklist.id,
      orderedItemIds: items.map((i) => i.id).reverse(),
    });
    expect(checklistItemJobIds()).toEqual([]);
  });

  it('deleteChecklistItem enqueues the deleted id, and the job tombstones it', async () => {
    const { items } = await checklistWith(['Doomed']);
    const [ci] = items;
    if (!ci) throw new Error('fixture');
    await embedding.embedEntity('CHECKLIST_ITEM', ci.id);
    expect(await embeddingCount(ci.id)).toBeGreaterThan(0);
    enqueued.length = 0;

    await actions.deleteChecklistItem({ id: ci.id });
    expect(checklistItemJobIds()).toEqual([ci.id]);

    await runEmbedJobs();
    expect(await embeddingCount(ci.id)).toBe(0);
  });

  it('deleteChecklist enqueues every child captured before the cascade', async () => {
    const { checklist, items } = await checklistWith(['A', 'B']);
    for (const ci of items) await embedding.embedEntity('CHECKLIST_ITEM', ci.id);
    enqueued.length = 0;

    await actions.deleteChecklist(checklist.id);
    expect(checklistItemJobIds().sort()).toEqual(items.map((i) => i.id).sort());

    await runEmbedJobs();
    for (const ci of items) expect(await embeddingCount(ci.id)).toBe(0);
  });

  it('saveAcceptedChecklist enqueues each created item', async () => {
    const log = await ctx.prisma.aISuggestionLog.create({
      data: {
        userId: 'u1',
        kind: 'checklist',
        systemPromptVersion: 'v1',
        model: 'm',
        inventorySnapshotIds: [],
      },
    });
    const r = await suggest.saveAcceptedChecklist({
      logId: log.id,
      name: 'Winterize',
      items: [
        { title: 'Drain hoses', itemId: null, rationale: 'r' },
        { title: 'Cover the AC unit', itemId: null, rationale: 'r' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const created = await ctx.prisma.checklistItem.findMany({
      where: { checklistId: r.data.checklistId },
      select: { id: true },
    });
    expect(checklistItemJobIds().sort()).toEqual(created.map((c) => c.id).sort());
  });
});
