import { randomUUID } from 'node:crypto';
import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/env', () => ({
  getEnv: () => ({ ASK_ENABLED: process.env.ASK_ENABLED === 'true' }),
}));

// Capture what reaches pg-boss (the backfill's only side channel).
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

// OCR's availability, as the backfill's retry step probes it.
const ocr = vi.hoisted(() => ({ available: true, probes: 0 }));
vi.mock('@/lib/ocr/tesseract', async () => {
  const { OcrUnavailableError } = await import('@/lib/ocr/errors');
  return {
    ensureOcrAvailable: async () => {
      ocr.probes++;
      if (!ocr.available) throw new OcrUnavailableError('still down');
    },
  };
});

type EmbedJob = { entityType: EmbeddingEntityType; entityId: string };

function embedJobs(): EmbedJob[] {
  return enqueued.filter((e) => e.queue === 'embed.content').map((e) => e.data as EmbedJob);
}

let ctx: IntegrationContext;
let retrieve: typeof import('@/lib/ask/retrieve');
let backfill: typeof import('@/worker/jobs/embed-backfill');
let embedding: typeof import('@/lib/embedding');
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
  backfill = await import('@/worker/jobs/embed-backfill');
  embedding = await import('@/lib/embedding');
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'liveness' },
    create: { slug: 'liveness', name: 'Liveness', sortOrder: 41 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
  delete process.env.ASK_ENABLED;
});

beforeEach(async () => {
  enqueued.length = 0;
  ocr.available = true;
  ocr.probes = 0;
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
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

  it('an email attachment unlinked from its service record leaves Ask', async () => {
    // Deleting a drafted record detaches (not deletes) the email's files. The
    // attachment is inbox-only again: untriaged sender content, which Ask must
    // not see, even though it was extracted and embedded while linked.
    const email = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<detached@a>',
        fromAddress: 'billing@acme.example',
        subject: 'Invoice',
        receivedAt: new Date(),
        headersJson: {},
      },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'From email', performedOn: todayUtcMidnight() },
    });
    const att = await seedAttachment({});
    await ctx.prisma.attachment.update({
      where: { id: att.id },
      data: { incomingEmailId: email.id, serviceRecordId: sr.id },
    });
    await seedEmbedding('ATTACHMENT', att.id);
    expect(await retrieve.retrieveTopK(QUERY, { k: 10 })).toHaveLength(1); // linked: live

    await ctx.prisma.attachment.update({
      where: { id: att.id },
      data: { serviceRecordId: null },
    });

    // Gone from retrieval at once, and the re-embed the detach queues
    // tombstones it rather than re-embedding it without the parent.
    expect(await retrieve.retrieveTopK(QUERY, { k: 10 })).toEqual([]);
    expect(await embedding.currentContentHash('ATTACHMENT', att.id)).toBeNull();
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
    const livePart = await ctx.prisma.part.create({
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
    await seedEmbedding('PART', livePart.id);

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
        livePart.id,
      ].sort(),
    );
  });
});

describe('embed.backfill reconciles the embeddings table', () => {
  it('sweeps embeddings of sources removed by DB cascade, even with Ask off', async () => {
    process.env.ASK_ENABLED = 'false';
    const keep = await ctx.prisma.note.create({ data: { title: 'Keep', body: 'k' } });
    const doomed = await ctx.prisma.note.create({ data: { title: 'Doomed', body: 'd' } });
    const att = await seedAttachment({ noteId: doomed.id });
    const checklist = await ctx.prisma.checklist.create({
      data: { name: 'Spring', items: { create: [{ title: 'Gutters', position: 0 }] } },
      include: { items: true },
    });
    const [ci] = checklist.items;
    if (!ci) throw new Error('fixture');
    await seedEmbedding('NOTE', keep.id);
    await seedEmbedding('ATTACHMENT', att.id);
    await seedEmbedding('CHECKLIST_ITEM', ci.id);

    // Both removals are FK-level cascades. No app code sees these rows go.
    await ctx.prisma.note.delete({ where: { id: doomed.id } });
    await ctx.prisma.checklist.delete({ where: { id: checklist.id } });

    await backfill.handleEmbedBackfill();

    const left = await ctx.prisma.embedding.findMany({
      select: { entityType: true, entityId: true },
    });
    expect(left).toEqual([{ entityType: 'NOTE', entityId: keep.id }]);
    expect(embedJobs()).toEqual([]); // Ask off: the sweep ran, nothing was enqueued
  });

  it('re-enqueues an entity whose stored hash no longer matches its text (P-H2)', async () => {
    const stale = await ctx.prisma.note.create({ data: { title: 'Edited', body: 'new body' } });
    const fresh = await ctx.prisma.note.create({ data: { title: 'Untouched', body: 'same' } });
    await seedEmbedding('NOTE', stale.id, 'hash-of-the-text-before-a-failed-re-embed');
    const freshHash = await embedding.currentContentHash('NOTE', fresh.id);
    if (!freshHash) throw new Error('fixture');
    await seedEmbedding('NOTE', fresh.id, freshHash);

    await backfill.handleEmbedBackfill();

    const noteJobs = embedJobs()
      .filter((j) => j.entityType === 'NOTE')
      .map((j) => j.entityId);
    expect(noteJobs).toContain(stale.id);
    expect(noteJobs).not.toContain(fresh.id);
  });
});

describe('embed.backfill re-extracts attachments OCR could not reach', () => {
  function extractJobs(): string[] {
    return enqueued
      .filter((e) => e.queue === 'attachment.extract-text')
      .map((e) => (e.data as { attachmentId: string }).attachmentId);
  }

  async function seedFailedExtract(
    note: { id: string },
    extractedError: string,
    aiIndexable = true,
  ): Promise<string> {
    const a = await seedAttachment({ noteId: note.id }, aiIndexable);
    await ctx.prisma.attachment.update({
      where: { id: a.id },
      data: { extractedText: null, extractedAt: new Date(), extractedError },
    });
    return a.id;
  }

  it('re-enqueues ocr_unavailable rows, and only those', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Receipts', body: 'r' } });
    const unavailable = await seedFailedExtract(note, 'ocr_unavailable');
    await seedFailedExtract(note, 'extract_threw'); // may be the file's fault: never looped
    await seedFailedExtract(note, 'image_decode_failed');
    await seedFailedExtract(note, 'ocr_unavailable', false); // opted out of AI

    await backfill.handleEmbedBackfill();

    expect(extractJobs()).toEqual([unavailable]);
  });

  it('marks its jobs so a duplicate that runs after a successful retry is skipped', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Receipts', body: 'r' } });
    const id = await seedFailedExtract(note, 'ocr_unavailable');

    await backfill.handleEmbedBackfill();

    expect(enqueued.filter((e) => e.queue === 'attachment.extract-text')).toEqual([
      { queue: 'attachment.extract-text', data: { attachmentId: id, onlyIfOcrUnavailable: true } },
    ]);
  });

  it('enqueues nothing while OCR is still down (no nightly re-decode of every file)', async () => {
    ocr.available = false;
    const note = await ctx.prisma.note.create({ data: { title: 'Receipts', body: 'r' } });
    await seedFailedExtract(note, 'ocr_unavailable');

    await backfill.handleEmbedBackfill();

    expect(extractJobs()).toEqual([]);
  });

  it('does not probe OCR when there is nothing to retry', async () => {
    await backfill.handleEmbedBackfill();
    expect(ocr.probes).toBe(0);
  });

  it('does not re-extract with Ask off (the extract job would no-op anyway)', async () => {
    process.env.ASK_ENABLED = 'false';
    const note = await ctx.prisma.note.create({ data: { title: 'Receipts', body: 'r' } });
    await seedFailedExtract(note, 'ocr_unavailable');

    await backfill.handleEmbedBackfill();

    expect(extractJobs()).toEqual([]);
  });
});

describe('embed.backfill extracts attachments that were never extracted', () => {
  const HOUR = 60 * 60 * 1000;
  function extractJobs(): unknown[] {
    return enqueued.filter((e) => e.queue === 'attachment.extract-text').map((e) => e.data);
  }

  async function seed(opts: {
    inbound?: 'inbox' | 'linked';
    extracted?: boolean;
    aiIndexable?: boolean;
    ageMs?: number;
    extractedError?: string;
  }): Promise<string> {
    const email = opts.inbound
      ? await ctx.prisma.incomingEmail.create({
          data: {
            messageId: `<${randomUUID()}@a>`,
            fromAddress: 'billing@acme.example',
            subject: 'Invoice',
            receivedAt: new Date(),
            headersJson: {},
          },
        })
      : null;
    const sr =
      opts.inbound === 'linked'
        ? await ctx.prisma.serviceRecord.create({
            data: { summary: 'From email', performedOn: todayUtcMidnight() },
          })
        : null;
    const item = email ? null : await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const id = randomUUID();
    await ctx.prisma.attachment.create({
      data: {
        id,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storagePath: `${id}/original.pdf`,
        uploadedById: 'u1',
        aiIndexable: opts.aiIndexable ?? true,
        extractedText: opts.extracted ? 'text' : null,
        extractedAt: opts.extracted ? new Date() : null,
        extractedError: opts.extractedError ?? null,
        createdAt: new Date(Date.now() - (opts.ageMs ?? 2 * HOUR)),
        incomingEmailId: email?.id ?? null,
        serviceRecordId: sr?.id ?? null,
        itemId: item?.id ?? null,
      },
    });
    return id;
  }

  it('enqueues never-extracted member uploads and LINKED email attachments only', async () => {
    const upload = await seed({});
    const linked = await seed({ inbound: 'linked' });
    await seed({ inbound: 'inbox' }); // untriaged sender content: never
    await seed({ extracted: true }); // already done
    await seed({ aiIndexable: false }); // opted out
    await seed({ ageMs: 5 * 60 * 1000 }); // fresh: its upload job is still queued
    // A decode that took the worker down with it. Queuing it at every boot
    // would crash-loop the worker; pg-boss's own retries already had a go.
    await seed({ extractedError: 'extract_interrupted' });

    await backfill.handleEmbedBackfill();

    expect(extractJobs()).toEqual(
      expect.arrayContaining([
        { attachmentId: upload, onlyIfUnextracted: true },
        { attachmentId: linked, onlyIfUnextracted: true },
      ]),
    );
    expect(extractJobs()).toHaveLength(2);
  });
});

function todayUtcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
