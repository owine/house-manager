import { randomUUID } from 'node:crypto';
import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let retrieve: typeof import('@/lib/ask/retrieve');
let categoryId: string;

// Every seeded chunk and the query share one direction, so the result does not
// depend on which IVFFlat list a row lands in. The index was built on an empty
// table with 100 lists and is queried at probes=1 (P-H1, deferred), and
// identical vectors land in the query's list whatever the plan.
const VEC = `[${new Array(1024).fill(0.001).join(',')}]`;
const QUERY = new Float32Array(1024).fill(0.001);

async function seedEmbedding(
  entityType: EmbeddingEntityType,
  entityId: string,
  contentHash = 'seeded',
): Promise<void> {
  await ctx.prisma.$executeRaw`
    INSERT INTO embeddings (id, "entityType", "entityId", "chunkIndex", text, embedding, "tokenCount", "contentHash", "createdAt")
    VALUES (${randomUUID()}, ${entityType}::"EmbeddingEntityType", ${entityId}, 0, ${`text for ${entityId}`}, ${VEC}::vector(1024), 1, ${contentHash}, NOW())
  `;
}

async function seedAttachment(parent: { noteId?: string; itemId?: string }, aiIndexable = true) {
  const id = randomUUID();
  return ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storagePath: `${id}/original.pdf`,
      uploadedById: 'u1',
      extractedText: 'Invoice total $450',
      aiIndexable,
      ...parent,
    },
  });
}

beforeAll(async () => {
  ctx = await setupIntegration();
  retrieve = await import('@/lib/ask/retrieve');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'liveness' },
    create: { slug: 'liveness', name: 'Liveness', sortOrder: 41 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.checklistItem.deleteMany();
  await ctx.prisma.checklist.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@x', name: 'Test' } });
});

describe('retrieveTopK only returns chunks whose source is live (Q-H2)', () => {
  it('drops deleted, archived and opted-out sources and keeps live ones', async () => {
    const note = await ctx.prisma.note.create({
      data: { title: 'Furnace filter', body: '20x25x1' },
    });
    const archived = await ctx.prisma.item.create({
      data: { name: 'Old fridge', categoryId, archivedAt: new Date() },
    });
    const optedOut = await seedAttachment({ noteId: note.id }, false);
    const checklist = await ctx.prisma.checklist.create({
      data: { name: 'Spring', items: { create: [{ title: 'Gutters', position: 0 }] } },
      include: { items: true },
    });
    const [ci] = checklist.items;
    if (!ci) throw new Error('fixture');

    await seedEmbedding('NOTE', note.id);
    await seedEmbedding('CHECKLIST_ITEM', ci.id);
    await seedEmbedding('NOTE', 'note-that-was-deleted');
    await seedEmbedding('CHECKLIST_ITEM', 'checklist-item-that-was-deleted');
    await seedEmbedding('ITEM', archived.id);
    await seedEmbedding('ATTACHMENT', optedOut.id);

    const chunks = await retrieve.retrieveTopK(QUERY, { k: 10 });
    expect(chunks.map((c) => c.entityId).sort()).toEqual([note.id, ci.id].sort());
  });

  it('a source removed by DB cascade vanishes from retrieval at once, before any sweep', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Water heater', body: 'Invoice' } });
    const att = await seedAttachment({ noteId: note.id });
    await seedEmbedding('NOTE', note.id);
    await seedEmbedding('ATTACHMENT', att.id);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10 })).toHaveLength(2);

    await ctx.prisma.note.delete({ where: { id: note.id } }); // cascades the attachment row
    expect(await retrieve.retrieveTopK(QUERY, { k: 10 })).toEqual([]);
    // The rows are still there. Removing them is the sweep's job (Task 5).
    expect(await ctx.prisma.embedding.count()).toBe(2);
  });

  it('still honours k and the entityTypes filter', async () => {
    const notes = await Promise.all(
      ['a', 'b', 'c'].map((t) => ctx.prisma.note.create({ data: { title: t, body: t } })),
    );
    for (const n of notes) await seedEmbedding('NOTE', n.id);

    expect(await retrieve.retrieveTopK(QUERY, { k: 2 })).toHaveLength(2);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10, entityTypes: ['ITEM'] })).toEqual([]);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10, entityTypes: ['NOTE'] })).toHaveLength(3);
  });

  it('each of the 7 EmbeddingEntityType values is live iff buildCanonical would embed it', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Live note', body: 'x' } });
    const liveItem = await ctx.prisma.item.create({ data: { name: 'Live item', categoryId } });
    const archivedItem = await ctx.prisma.item.create({
      data: { name: 'Dead item', categoryId, archivedAt: new Date() },
    });
    const checklist = await ctx.prisma.checklist.create({
      data: {
        name: 'Types',
        items: { create: [{ title: 'Live ci', position: 0 }] },
      },
      include: { items: true },
    });
    const [liveCi] = checklist.items;
    if (!liveCi) throw new Error('fixture');
    const liveAttachment = await seedAttachment({ noteId: note.id }, true);
    const deadAttachment = await seedAttachment({ noteId: note.id }, false);
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });
    const liveServiceRecord = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Live sr', performedOn: todayUtcMidnight(), vendorId: vendor.id },
    });
    const liveWarranty = await ctx.prisma.warranty.create({
      data: {
        provider: 'Live warranty',
        startsOn: todayUtcMidnight(),
        endsOn: todayUtcMidnight(),
      },
    });
    const partCategoryPlaceholder = await ctx.prisma.part.create({
      data: { name: 'Live part' },
    });
    const archivedPart = await ctx.prisma.part.create({
      data: { name: 'Dead part', archivedAt: new Date() },
    });

    // Live variant of every type.
    await seedEmbedding('ITEM', liveItem.id);
    await seedEmbedding('NOTE', note.id);
    await seedEmbedding('SERVICE_RECORD', liveServiceRecord.id);
    await seedEmbedding('CHECKLIST_ITEM', liveCi.id);
    await seedEmbedding('WARRANTY', liveWarranty.id);
    await seedEmbedding('ATTACHMENT', liveAttachment.id);
    await seedEmbedding('PART', partCategoryPlaceholder.id);

    // Dead variant of every type: deleted row for NOTE/SERVICE_RECORD/WARRANTY/CHECKLIST_ITEM,
    // archived for ITEM/PART, aiIndexable=false for ATTACHMENT.
    await seedEmbedding('ITEM', archivedItem.id);
    await seedEmbedding('NOTE', 'deleted-note-id');
    await seedEmbedding('SERVICE_RECORD', 'deleted-sr-id');
    await seedEmbedding('CHECKLIST_ITEM', 'deleted-ci-id');
    await seedEmbedding('WARRANTY', 'deleted-warranty-id');
    await seedEmbedding('ATTACHMENT', deadAttachment.id);
    await seedEmbedding('PART', archivedPart.id);

    const chunks = await retrieve.retrieveTopK(QUERY, { k: 20 });
    expect(chunks.map((c) => c.entityId).sort()).toEqual(
      [
        liveItem.id,
        note.id,
        liveServiceRecord.id,
        liveCi.id,
        liveWarranty.id,
        liveAttachment.id,
        partCategoryPlaceholder.id,
      ].sort(),
    );
  });
});

function todayUtcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
