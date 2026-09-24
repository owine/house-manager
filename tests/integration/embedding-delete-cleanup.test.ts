import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEntityType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calDaysOut,
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// deleteAttachment reads FILES_DIR. The full Zod env would demand unrelated secrets.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    ASK_ENABLED: process.env.ASK_ENABLED === 'true',
    FILES_DIR: process.env.FILES_DIR,
  }),
}));
vi.mock('@/lib/search/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/search/client')>();
  return { ...orig, enqueueSearchIndex: vi.fn(async () => 'job-id') };
});

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

// Never call Voyage. The texts are captured so a re-parent test can prove the
// "Linked to <parent>" line actually changed.
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

let ctx: IntegrationContext;
let attachments: typeof import('@/lib/attachments/actions');
let notes: typeof import('@/lib/notes/actions');
let warranties: typeof import('@/lib/warranties/actions');
let serviceRecords: typeof import('@/lib/service-records/actions');
let inbox: typeof import('@/lib/incoming-email/actions');
let embedding: typeof import('@/lib/embedding');
let itemId: string;
const originalFilesDir = process.env.FILES_DIR;

/** Play the captured jobs through the real consumer, as the worker would. */
async function runEmbedJobs(): Promise<void> {
  for (const job of embedJobs()) await embedding.embedEntity(job.entityType, job.entityId);
}

async function count(entityType: EmbeddingEntityType, entityId: string): Promise<number> {
  return ctx.prisma.embedding.count({ where: { entityType, entityId } });
}

async function seedAttachment(
  parent: Partial<Record<'noteId' | 'warrantyId' | 'serviceRecordId', string>>,
) {
  const id = randomUUID();
  const att = await ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storagePath: `${id}/original.pdf`,
      uploadedById: 'u1',
      extractedText: 'Invoice #123 — total $450',
      ...parent,
    },
  });
  // A real embedding, written the way the worker writes it.
  await embedding.embedEntity('ATTACHMENT', att.id);
  expect(await count('ATTACHMENT', att.id)).toBeGreaterThan(0);
  return att;
}

/** An inbound-email attachment, optionally already linked to a service record. */
async function seedEmailAttachment(serviceRecordId: string | null = null) {
  const vendor = await ctx.prisma.vendor.create({ data: { name: `Acme ${randomUUID()}` } });
  const email = await ctx.prisma.incomingEmail.create({
    data: {
      messageId: `<${randomUUID()}@example.com>`,
      fromAddress: 'dispatch@acme.example',
      subject: 'Spring HVAC tune-up',
      receivedAt: new Date(),
      headersJson: {},
      vendorId: vendor.id,
      // A calendar date, so createServiceRecordFromEmail never falls back to
      // receivedAt + getHouseTimezone().
      aiExtractedPerformedOn: todayCal(),
      targets: { create: [{ itemId }] },
    },
  });
  const id = randomUUID();
  const att = await ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storagePath: `${id}/original.pdf`,
      uploadedById: 'u1',
      extractedText: 'Invoice #456 — total $180',
      incomingEmailId: email.id,
      serviceRecordId,
    },
  });
  await embedding.embedEntity('ATTACHMENT', att.id);
  return { email, att };
}

/** Run the captured jobs, then return only the text they embedded. */
async function embeddedTextOfJobs(): Promise<string> {
  embeddedTexts.length = 0;
  await runEmbedJobs();
  return embeddedTexts.flat().join('\n');
}

beforeAll(async () => {
  ctx = await setupIntegration();
  process.env.FILES_DIR = await mkdtemp(join(tmpdir(), 'embed-cleanup-'));
  attachments = await import('@/lib/attachments/actions');
  notes = await import('@/lib/notes/actions');
  warranties = await import('@/lib/warranties/actions');
  serviceRecords = await import('@/lib/service-records/actions');
  inbox = await import('@/lib/incoming-email/actions');
  embedding = await import('@/lib/embedding');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
  process.env.FILES_DIR = originalFilesDir;
  delete process.env.ASK_ENABLED;
});

beforeEach(async () => {
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@x', name: 'Test' } });
  embeddedTexts.length = 0;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'cleanup' },
    create: { slug: 'cleanup', name: 'Cleanup', sortOrder: 42 },
    update: {},
  });
  itemId = (await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId: cat.id } })).id;
  enqueued.length = 0;
});

describe('delete actions tombstone every embeddable row they remove (Q-H2)', () => {
  it('deleteAttachment enqueues ATTACHMENT, and the job removes its embeddings', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Furnace', body: 'b' } });
    const att = await seedAttachment({ noteId: note.id });
    enqueued.length = 0;

    const r = await attachments.deleteAttachment(att.id);
    expect(r.ok).toBe(true);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });

  it('deleteNote also tombstones the attachments its FK cascade removes', async () => {
    const note = await ctx.prisma.note.create({ data: { title: 'Water heater', body: 'b' } });
    await embedding.embedEntity('NOTE', note.id);
    const att = await seedAttachment({ noteId: note.id });
    enqueued.length = 0;

    await notes.deleteNote(note.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    expect(await count('NOTE', note.id)).toBe(0);
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });

  it('deleteWarranty also tombstones the attachments its FK cascade removes', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        provider: 'Acme',
        startsOn: todayCal(),
        endsOn: calDaysOut(365),
        targets: { create: [{ itemId }] },
      },
    });
    const att = await seedAttachment({ warrantyId: w.id });
    enqueued.length = 0;

    await warranties.deleteWarranty(w.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });

  it('deleteServiceRecord also re-embeds or tombstones its attachments', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Tune-up', performedOn: todayCal(), targets: { create: [{ itemId }] } },
    });
    const att = await seedAttachment({ serviceRecordId: sr.id });
    enqueued.length = 0;

    await serviceRecords.deleteServiceRecord(sr.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    await runEmbedJobs();
    // A plain SR attachment cascades away.
    expect(await count('ATTACHMENT', att.id)).toBe(0);
  });
});

// The canonical text names the attachment's parent ("Linked to serviceRecord:
// <summary>"), so a link or unlink changes what should be embedded even though
// extractedText is untouched.
describe('re-parenting an email attachment re-embeds it (handed over from PR C)', () => {
  it('createServiceRecordFromEmail re-embeds the attachments it links', async () => {
    const { email, att } = await seedEmailAttachment();
    enqueued.length = 0;

    const r = await inbox.createServiceRecordFromEmail({ id: email.id });
    expect(r.ok).toBe(true);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    expect(await embeddedTextOfJobs()).toContain('Linked to serviceRecord: Spring HVAC tune-up');
  });

  it('deleteAttachment on an email-owned attachment unlinks it and re-embeds it', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Tune-up', performedOn: todayCal(), targets: { create: [{ itemId }] } },
    });
    const { att } = await seedEmailAttachment(sr.id);
    enqueued.length = 0;

    const r = await attachments.deleteAttachment(att.id);
    expect(r.ok).toBe(true);
    // PR C's unlink branch: the row survives, detached from the record.
    expect(
      (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).serviceRecordId,
    ).toBeNull();
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    const text = await embeddedTextOfJobs();
    expect(text).toContain('Invoice #456');
    expect(text).not.toContain('Linked to serviceRecord');
    expect(await count('ATTACHMENT', att.id)).toBeGreaterThan(0);
  });

  it('deleteServiceRecord re-embeds the email attachments it detaches', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Tune-up', performedOn: todayCal(), targets: { create: [{ itemId }] } },
    });
    const { att } = await seedEmailAttachment(sr.id);
    enqueued.length = 0;

    await serviceRecords.deleteServiceRecord(sr.id);
    expect(embedJobs()).toContainEqual(
      expect.objectContaining({ entityType: 'ATTACHMENT', entityId: att.id }),
    );

    const text = await embeddedTextOfJobs();
    expect(text).not.toContain('Linked to serviceRecord');
    expect(await count('ATTACHMENT', att.id)).toBeGreaterThan(0);
  });
});
