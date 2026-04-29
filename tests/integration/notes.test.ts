import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'notes-test' },
    create: { slug: 'notes-test', name: 'Notes Test', sortOrder: 99 },
    update: {},
  });
  categoryId = cat.id;

  const item = await ctx.prisma.item.create({
    data: { name: 'Test Item for Notes', categoryId },
  });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.note.deleteMany();
});

describe('Note CRUD', () => {
  it('creates a note attached to an item', async () => {
    const note = await ctx.prisma.note.create({
      data: {
        title: 'Attached note',
        body: '## Heading\n\nSome content.',
        itemId,
        tags: ['urgent'],
      },
    });

    expect(note.id).toBeTruthy();
    expect(note.title).toBe('Attached note');
    expect(note.itemId).toBe(itemId);
    expect(note.tags).toEqual(['urgent']);
  });

  it('creates a note WITHOUT an item (freestanding)', async () => {
    const note = await ctx.prisma.note.create({
      data: {
        title: 'Freestanding note',
        body: 'No item attached.',
        tags: [],
      },
    });

    expect(note.id).toBeTruthy();
    expect(note.itemId).toBeNull();
  });

  it('updates body and tags; re-reads and confirms', async () => {
    const note = await ctx.prisma.note.create({
      data: {
        title: 'Original title',
        body: 'Original body',
        tags: ['old-tag'],
      },
    });

    await ctx.prisma.note.update({
      where: { id: note.id },
      data: { body: 'Updated body', tags: ['new-tag', 'another'] },
    });

    const updated = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(updated?.body).toBe('Updated body');
    expect(updated?.tags).toEqual(['new-tag', 'another']);
  });

  it('deletes a note; findUnique returns null', async () => {
    const note = await ctx.prisma.note.create({
      data: { title: 'To delete', body: 'Goodbye.' },
    });

    await ctx.prisma.note.delete({ where: { id: note.id } });

    const deleted = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(deleted).toBeNull();
  });

  it('updates a note to detach from its item (itemId: null)', async () => {
    const note = await ctx.prisma.note.create({
      data: { title: 'Was attached', body: 'Content', itemId },
    });

    await ctx.prisma.note.update({ where: { id: note.id }, data: { itemId: null } });

    const updated = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(updated?.itemId).toBeNull();
  });

  it('hard-deletes the parent Item — note itemId becomes null (SetNull)', async () => {
    const tempItem = await ctx.prisma.item.create({
      data: { name: 'Temp Item for SetNull Test', categoryId },
    });
    const note = await ctx.prisma.note.create({
      data: { title: 'Linked note', body: 'Will be orphaned', itemId: tempItem.id },
    });

    await ctx.prisma.item.delete({ where: { id: tempItem.id } });

    const orphan = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(orphan?.itemId).toBeNull();
  });
});

describe('Note Prisma filters', () => {
  it('listNotes q matches title (case-insensitive)', async () => {
    await ctx.prisma.note.createMany({
      data: [
        { title: 'Furnace inspection notes', body: 'Body A' },
        { title: 'AC repair log', body: 'Body B' },
        { title: 'Furnace filter change', body: 'Body C' },
      ],
    });

    const notes = await ctx.prisma.note.findMany({
      where: {
        OR: [
          { title: { contains: 'furnace', mode: 'insensitive' } },
          { body: { contains: 'furnace', mode: 'insensitive' } },
        ],
      },
    });

    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.title.toLowerCase()).toContain('furnace');
    }
  });

  it('listNotes q matches body (case-insensitive)', async () => {
    await ctx.prisma.note.createMany({
      data: [
        { title: 'Note A', body: 'Furnace was serviced today' },
        { title: 'Note B', body: 'AC filter replaced' },
      ],
    });

    const notes = await ctx.prisma.note.findMany({
      where: {
        OR: [
          { title: { contains: 'furnace', mode: 'insensitive' } },
          { body: { contains: 'furnace', mode: 'insensitive' } },
        ],
      },
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Note A');
  });

  it('itemId filter returns only attached notes for that item', async () => {
    const otherItem = await ctx.prisma.item.create({
      data: { name: 'Other Item for Notes Filter', categoryId },
    });

    await ctx.prisma.note.createMany({
      data: [
        { title: 'Note for item', body: 'Body', itemId },
        { title: 'Note for other item', body: 'Body', itemId: otherItem.id },
        { title: 'Freestanding', body: 'Body' },
      ],
    });

    const notes = await ctx.prisma.note.findMany({
      where: { itemId },
      include: { item: { select: { id: true, name: true } } },
    });
    const total = await ctx.prisma.note.count({ where: { itemId } });

    expect(total).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0].itemId).toBe(itemId);

    await ctx.prisma.item.delete({ where: { id: otherItem.id } });
  });
});
