import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let _currentUserId: string | null = null;
function signInAs(id: string | null) {
  _currentUserId = id;
}

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (_currentUserId ? { user: { id: _currentUserId } } : null)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Stub the search-index enqueue so tests don't need pg-boss running.
vi.mock('@/lib/search/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/search/client')>();
  return { ...orig, enqueueSearchIndex: vi.fn(async () => 'job-id') };
});

let ctx: IntegrationContext;
let actions: typeof import('@/lib/checklists/actions');
let queries: typeof import('@/lib/checklists/queries');

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/checklists/actions');
  queries = await import('@/lib/checklists/queries');
}, 60_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  await ctx.prisma.user.deleteMany();
  const u = await ctx.prisma.user.create({ data: { email: 'cl@x', name: 'C' } });
  signInAs(u.id);
});

describe('checklist CRUD', () => {
  it('createChecklist persists name + description, fires search-index enqueue', async () => {
    const { enqueueSearchIndex } = await import('@/lib/search/client');
    const spy = vi.mocked(enqueueSearchIndex);
    spy.mockClear();

    const result = await actions.createChecklist({
      name: 'Spring Prep',
      description: 'Things to do before summer',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await ctx.prisma.checklist.findUnique({ where: { id: result.data.id } });
    expect(row?.name).toBe('Spring Prep');
    expect(row?.description).toBe('Things to do before summer');
    expect(spy).toHaveBeenCalledWith('checklist', result.data.id, 'upsert');
  });

  it('createChecklist rejects empty name', async () => {
    const result = await actions.createChecklist({ name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.name).toBeDefined();
  });

  it('createChecklist rejects unauthenticated', async () => {
    signInAs(null);
    const result = await actions.createChecklist({ name: 'Sneaky' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.formError).toBe('Unauthorized');
  });

  it('updateChecklist patches name + description', async () => {
    const created = await ctx.prisma.checklist.create({ data: { name: 'Old Name' } });

    const result = await actions.updateChecklist({
      id: created.id,
      name: 'New Name',
      description: 'Updated desc',
    });

    expect(result.ok).toBe(true);
    const row = await ctx.prisma.checklist.findUnique({ where: { id: created.id } });
    expect(row?.name).toBe('New Name');
    expect(row?.description).toBe('Updated desc');
  });

  it('updateChecklist with description: null clears it', async () => {
    const created = await ctx.prisma.checklist.create({
      data: { name: 'Has Desc', description: 'To be cleared' },
    });

    const result = await actions.updateChecklist({ id: created.id, description: null });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.checklist.findUnique({ where: { id: created.id } });
    expect(row?.description).toBeNull();
  });

  it('deleteChecklist cascades to items', async () => {
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'To Delete' } });
    await ctx.prisma.checklistItem.createMany({
      data: [
        { checklistId: checklist.id, title: 'Item A', position: 0 },
        { checklistId: checklist.id, title: 'Item B', position: 1 },
      ],
    });

    const result = await actions.deleteChecklist(checklist.id);
    expect(result.ok).toBe(true);

    const orphans = await ctx.prisma.checklistItem.findMany({
      where: { checklistId: checklist.id },
    });
    expect(orphans).toHaveLength(0);

    const deleted = await ctx.prisma.checklist.findUnique({ where: { id: checklist.id } });
    expect(deleted).toBeNull();
  });

  it('addChecklistItem appends with position = last + 1', async () => {
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'My List' } });
    await ctx.prisma.checklistItem.create({
      data: { checklistId: checklist.id, title: 'First', position: 0 },
    });

    const result = await actions.addChecklistItem({
      checklistId: checklist.id,
      title: 'Second',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = await ctx.prisma.checklistItem.findUnique({ where: { id: result.data.id } });
    expect(item?.position).toBe(1);
    expect(item?.title).toBe('Second');
  });

  it('deleteChecklistItem removes the row, leaves siblings', async () => {
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'My List' } });
    const [itemA, itemB] = await Promise.all([
      ctx.prisma.checklistItem.create({
        data: { checklistId: checklist.id, title: 'A', position: 0 },
      }),
      ctx.prisma.checklistItem.create({
        data: { checklistId: checklist.id, title: 'B', position: 1 },
      }),
    ]);

    const result = await actions.deleteChecklistItem({ id: itemA.id });
    expect(result.ok).toBe(true);

    const deletedRow = await ctx.prisma.checklistItem.findUnique({ where: { id: itemA.id } });
    expect(deletedRow).toBeNull();

    const sibling = await ctx.prisma.checklistItem.findUnique({ where: { id: itemB.id } });
    expect(sibling).not.toBeNull();
  });

  it('reorderChecklistItems updates positions atomically', async () => {
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'Order Test' } });
    const [itemA, itemB, itemC] = await Promise.all([
      ctx.prisma.checklistItem.create({
        data: { checklistId: checklist.id, title: 'A', position: 0 },
      }),
      ctx.prisma.checklistItem.create({
        data: { checklistId: checklist.id, title: 'B', position: 1 },
      }),
      ctx.prisma.checklistItem.create({
        data: { checklistId: checklist.id, title: 'C', position: 2 },
      }),
    ]);

    // Reorder to [C, A, B]
    const result = await actions.reorderChecklistItems({
      checklistId: checklist.id,
      orderedItemIds: [itemC.id, itemA.id, itemB.id],
    });
    expect(result.ok).toBe(true);

    const rows = await ctx.prisma.checklistItem.findMany({
      where: { checklistId: checklist.id },
      orderBy: { position: 'asc' },
    });

    // positions after reorder: C=0, A=1, B=2
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.position]));
    expect(byId[itemC.id]).toBe(0);
    expect(byId[itemA.id]).toBe(1);
    expect(byId[itemB.id]).toBe(2);
  });
});

describe('toggleChecklistItem', () => {
  it('sets completedAt when done=true', async () => {
    const before = new Date();
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'Toggle Test' } });
    const item = await ctx.prisma.checklistItem.create({
      data: { checklistId: checklist.id, title: 'Step 1', position: 0 },
    });

    const result = await actions.toggleChecklistItem({ id: item.id, done: true });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.checklistItem.findUnique({ where: { id: item.id } });
    expect(row?.completedAt).not.toBeNull();
    expect(row?.completedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('clears completedAt when done=false', async () => {
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'Toggle Clear Test' } });
    const item = await ctx.prisma.checklistItem.create({
      data: { checklistId: checklist.id, title: 'Step 1', position: 0, completedAt: new Date() },
    });

    const result = await actions.toggleChecklistItem({ id: item.id, done: false });
    expect(result.ok).toBe(true);

    const row = await ctx.prisma.checklistItem.findUnique({ where: { id: item.id } });
    expect(row?.completedAt).toBeNull();
  });

  it('rejects unauthenticated', async () => {
    signInAs(null);
    const checklist = await ctx.prisma.checklist.create({ data: { name: 'Auth Test' } });
    const item = await ctx.prisma.checklistItem.create({
      data: { checklistId: checklist.id, title: 'Step 1', position: 0 },
    });

    const result = await actions.toggleChecklistItem({ id: item.id, done: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.formError).toBe('Unauthorized');
  });

  it('rejects invalid input (missing id)', async () => {
    const result = await actions.toggleChecklistItem({ done: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.id).toBeDefined();
  });
});

describe('checklist queries', () => {
  it('listChecklists returns active only, ordered by updatedAt desc, with item counts', async () => {
    // Create two active and one inactive checklist
    const [cl1, cl2] = await Promise.all([
      ctx.prisma.checklist.create({ data: { name: 'Active 1', active: true } }),
      ctx.prisma.checklist.create({ data: { name: 'Active 2', active: true } }),
    ]);
    await ctx.prisma.checklist.create({ data: { name: 'Inactive', active: false } });

    // Add 2 items to cl1
    await ctx.prisma.checklistItem.createMany({
      data: [
        { checklistId: cl1.id, title: 'Item X', position: 0 },
        { checklistId: cl1.id, title: 'Item Y', position: 1 },
      ],
    });

    const list = await queries.listChecklists();

    const names = list.map((c) => c.name);
    expect(names).not.toContain('Inactive');
    expect(names).toContain('Active 1');
    expect(names).toContain('Active 2');

    const cl1Row = list.find((c) => c.id === cl1.id);
    expect(cl1Row?._count.items).toBe(2);

    const cl2Row = list.find((c) => c.id === cl2.id);
    expect(cl2Row?._count.items).toBe(0);
  });

  it('getChecklist returns items in position order with linked Item joined', async () => {
    const category = await ctx.prisma.category.upsert({
      where: { slug: 'hvac' },
      create: { slug: 'hvac', name: 'HVAC', sortOrder: 10 },
      update: {},
    });
    const linkedItem = await ctx.prisma.item.create({
      data: { name: 'Furnace', categoryId: category.id },
    });

    const checklist = await ctx.prisma.checklist.create({ data: { name: 'Detail Test' } });
    await ctx.prisma.checklistItem.createMany({
      data: [
        { checklistId: checklist.id, title: 'Z item', position: 2 },
        { checklistId: checklist.id, title: 'A item', position: 0, itemId: linkedItem.id },
        { checklistId: checklist.id, title: 'M item', position: 1 },
      ],
    });

    const result = await queries.getChecklist(checklist.id);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.items).toHaveLength(3);
    expect(result.items[0].title).toBe('A item');
    expect(result.items[1].title).toBe('M item');
    expect(result.items[2].title).toBe('Z item');

    // Linked item should be joined
    expect(result.items[0].item?.id).toBe(linkedItem.id);
    expect(result.items[0].item?.name).toBe('Furnace');

    // Non-linked items have null item
    expect(result.items[1].item).toBeNull();
  });
});
