import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

let _currentUserId: string | null = null;
function signInAs(id: string | null) {
  _currentUserId = id;
}

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (_currentUserId ? { user: { id: _currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Spy on search-index enqueue. Both saveAcceptedReminders (existing) and
// saveAcceptedChecklist (new) call this; tests that care assert directly.
const enqueueSearchIndexMock = vi.fn(async () => 'job-id');
vi.mock('@/lib/search/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/search/client')>();
  return { ...orig, enqueueSearchIndex: enqueueSearchIndexMock };
});

let ctx: IntegrationContext;
let actions: typeof import('@/lib/ai/suggest/actions');
let categoryId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/ai/suggest/actions');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 60_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

describe('saveAcceptedReminders', () => {
  let userId: string;
  let logId: string;

  beforeEach(async () => {
    enqueueSearchIndexMock.mockClear();
    // FK-safe cleanup order
    await ctx.prisma.reminderCompletion.deleteMany();
    await ctx.prisma.notificationLog.deleteMany();
    await ctx.prisma.reminder.deleteMany();
    await ctx.prisma.checklistItem.deleteMany();
    await ctx.prisma.checklist.deleteMany();
    await ctx.prisma.aISuggestionLog.deleteMany();
    await ctx.prisma.item.deleteMany();
    await ctx.prisma.session.deleteMany();
    await ctx.prisma.account.deleteMany();
    await ctx.prisma.user.deleteMany();
    const u = await ctx.prisma.user.create({ data: { email: 'sr@x', name: 'S' } });
    userId = u.id;
    const log = await ctx.prisma.aISuggestionLog.create({
      data: {
        userId,
        kind: 'reminders',
        systemPromptVersion: 'v1',
        model: 'm',
        inventorySnapshotIds: [],
      },
    });
    logId = log.id;
    signInAs(userId);
  });

  it('inserts reminders + updates acceptedItemIds in one transaction', async () => {
    const result = await actions.saveAcceptedReminders({
      logId,
      accepted: [
        {
          title: 'Replace filter',
          description: 'q90d',
          recurrence: { kind: 'interval', days: 90 },
          leadTimeDays: 7,
          rationale: 'spec',
        },
        {
          title: 'Annual inspection',
          recurrence: { kind: 'yearly', month: 10, day: 15 },
          leadTimeDays: 14,
          rationale: 'preseason',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.data.savedIds).toHaveLength(2);

    const reminders = await ctx.prisma.reminder.findMany({
      where: { id: { in: result.data.savedIds } },
    });
    expect(reminders).toHaveLength(2);

    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: logId } });
    expect(log.acceptedItemIds).toEqual(result.data.savedIds);
  });

  it('attaches itemId when provided', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const result = await actions.saveAcceptedReminders({
      logId,
      itemId: item.id,
      accepted: [
        {
          title: 'Pinned',
          recurrence: { kind: 'interval', days: 30 },
          leadTimeDays: 3,
          rationale: 'r',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    const r = await ctx.prisma.reminder.findUniqueOrThrow({
      where: { id: result.data.savedIds[0] },
    });
    expect(r.itemId).toBe(item.id);
  });

  it('rejects empty accepted list', async () => {
    const result = await actions.saveAcceptedReminders({ logId, accepted: [] });
    expect(result.ok).toBe(false);
  });
});

describe('saveAcceptedChecklist', () => {
  let userId: string;
  let logId: string;

  beforeEach(async () => {
    enqueueSearchIndexMock.mockClear();
    await ctx.prisma.checklistItem.deleteMany();
    await ctx.prisma.checklist.deleteMany();
    await ctx.prisma.aISuggestionLog.deleteMany();
    await ctx.prisma.session.deleteMany();
    await ctx.prisma.account.deleteMany();
    await ctx.prisma.user.deleteMany();
    const u = await ctx.prisma.user.create({ data: { email: 'sc@x', name: 'C' } });
    userId = u.id;
    const log = await ctx.prisma.aISuggestionLog.create({
      data: {
        userId,
        kind: 'checklist',
        systemPromptVersion: 'v1',
        model: 'm',
        inventorySnapshotIds: [],
      },
    });
    logId = log.id;
    signInAs(userId);
  });

  it('creates a new checklist when appendToChecklistId is null', async () => {
    const r = await actions.saveAcceptedChecklist({
      logId,
      name: 'Spring 2026',
      description: 'd',
      items: [
        { title: 'A', itemId: null, rationale: 'r' },
        { title: 'B', itemId: null, rationale: 'r' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const cl = await ctx.prisma.checklist.findUniqueOrThrow({
      where: { id: r.data.checklistId },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    expect(cl.name).toBe('Spring 2026');
    expect(cl.items).toHaveLength(2);
    expect(cl.items.map((i) => i.position)).toEqual([0, 1]);

    // log gets the new checklist id appended
    const log = await ctx.prisma.aISuggestionLog.findUniqueOrThrow({ where: { id: logId } });
    expect(log.acceptedItemIds).toEqual([r.data.checklistId]);
  });

  it('appends to an existing checklist when appendToChecklistId is set', async () => {
    const existing = await ctx.prisma.checklist.create({
      data: { name: 'Quarterly', items: { create: [{ position: 0, title: 'Existing 1' }] } },
    });
    const r = await actions.saveAcceptedChecklist({
      logId,
      name: 'ignored when appending',
      items: [{ title: 'New 1', itemId: null, rationale: 'r' }],
      appendToChecklistId: existing.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.data.checklistId).toBe(existing.id);
    const items = await ctx.prisma.checklistItem.findMany({
      where: { checklistId: existing.id },
      orderBy: { position: 'asc' },
    });
    expect(items.map((i) => i.title)).toEqual(['Existing 1', 'New 1']);
    expect(items[1].position).toBe(1);
  });

  it('enqueues a checklist search-index sync after save', async () => {
    const r = await actions.saveAcceptedChecklist({
      logId,
      name: 'Indexable',
      items: [{ title: 'item', itemId: null, rationale: 'r' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(enqueueSearchIndexMock).toHaveBeenCalledWith('checklist', r.data.checklistId, 'upsert');
  });

  it('rejects empty items list', async () => {
    const r = await actions.saveAcceptedChecklist({ logId, name: 'X', items: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects missing name on create path', async () => {
    const r = await actions.saveAcceptedChecklist({
      logId,
      name: '',
      items: [{ title: 'A', itemId: null, rationale: 'r' }],
    });
    expect(r.ok).toBe(false);
  });
});
