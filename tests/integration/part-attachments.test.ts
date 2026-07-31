import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Only FILES_DIR is read on these paths; the full Zod env would demand a dozen
// unrelated production secrets (same narrowing as lib/embedding/voyage.test.ts).
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ FILES_DIR: process.env.FILES_DIR }),
}));

// pg-boss is not running here; capture the sends instead.
vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...orig,
    getBoss: vi.fn(async () => ({ send: vi.fn(async () => 'fake-job-id') })),
  };
});

const searchCalls: { kind: string; id: string }[] = [];
vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async (kind: string, id: string) => {
    searchCalls.push({ kind, id });
  }),
}));

const embedCalls: { type: string; id: string }[] = [];
vi.mock('@/lib/embedding/enqueue', () => ({
  enqueueEmbed: vi.fn(async (type: string, id: string) => {
    embedCalls.push({ type, id });
  }),
}));

// The text handed to Voyage is the assertion surface for the producer ladder in
// lib/embedding/index.ts. Asserting on the `select` instead would pass with a
// missing ternary rung, which is exactly how a part-attached file would embed
// with no "Linked to part:" line.
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

let ctx: IntegrationContext;
let attachments: typeof import('@/lib/attachments/actions');
let cascade: typeof import('@/lib/rename-cascade');
let embedding: typeof import('@/lib/embedding');
let filesDir: string;
const originalFilesDir = process.env.FILES_DIR;

async function jpegFile(name = 'filter-label.jpg'): Promise<File> {
  const bytes = await readFile('tests/fixtures/sample.jpg');
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

function uploadForm(parentType: string, parentId: string, file: File): FormData {
  const fd = new FormData();
  fd.set('parentType', parentType);
  fd.set('parentId', parentId);
  fd.set('file', file);
  return fd;
}

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = await mkdtemp(`${tmpdir()}/part-files-`);
  process.env.FILES_DIR = filesDir;
  attachments = await import('@/lib/attachments/actions');
  cascade = await import('@/lib/rename-cascade');
  embedding = await import('@/lib/embedding');
}, 180_000);

afterAll(async () => {
  process.env.FILES_DIR = originalFilesDir;
  delete process.env.ASK_ENABLED;
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  searchCalls.length = 0;
  embedCalls.length = 0;
  embeddedTexts.length = 0;
  process.env.ASK_ENABLED = 'true';
  await ctx.prisma.$executeRaw`DELETE FROM embeddings`;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

describe('uploading a file to a part', () => {
  it('stores the attachment under the part', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'FPR 10 20x25x1', kind: 'AIR_FILTER' },
    });

    const result = await attachments.uploadAttachment(
      uploadForm('part', part.id, await jpegFile()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.partId).toBe(part.id);
    expect(row.itemId).toBeNull();
  });

  it('returns a form error for an unknown part rather than throwing', async () => {
    const result = await attachments.uploadAttachment(
      uploadForm('part', 'no-such-part', await jpegFile()),
    );

    expect(result).toEqual({ ok: false, formError: 'Parent not found' });
    expect(await ctx.prisma.attachment.count()).toBe(0);
  });

  it('links an external URL to a part', async () => {
    const part = await ctx.prisma.part.create({ data: { name: 'Belt 4L360', kind: 'BELT' } });
    const fd = new FormData();
    fd.set('parentType', 'part');
    fd.set('parentId', part.id);
    fd.set('externalUrl', 'https://example.com/belt.pdf');

    const result = await attachments.addAttachmentLink(fd);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.partId).toBe(part.id);
  });
});

describe('a part-attached file embeds its parent name', () => {
  it('canonical text names the part', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'FPR 10 20x25x1', kind: 'AIR_FILTER' },
    });
    const att = await ctx.prisma.attachment.create({
      data: {
        filename: 'filter-label.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        storagePath: 'a1/original.jpg',
        uploadedById: 'u1',
        partId: part.id,
        extractedText: 'MERV 11 20x25x1 pleated air filter',
      },
    });

    const result = await embedding.embedEntity('ATTACHMENT', att.id);
    expect(result.status).toBe('embedded');

    const text = (embeddedTexts[0] ?? []).join('\n');
    expect(text).toContain('Linked to part: FPR 10 20x25x1');
    expect(text).toContain('MERV 11 20x25x1 pleated air filter');
  });
});

/**
 * The part half of the two-pipeline divergence documented in
 * lib/rename-cascade.ts. Service records land in BOTH pipelines; attachments
 * land in the embedding half only, because AttachmentRow in
 * lib/search/document.ts projects `item` and nothing else.
 */
describe('enqueuePartRenameCascade', () => {
  async function seed() {
    const part = await ctx.prisma.part.create({
      data: { name: 'FPR 10 20x25x1', kind: 'AIR_FILTER' },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        summary: 'Filter swap',
        performedOn: todayCal(),
        targets: { create: [{ partId: part.id }] },
      },
    });
    const att = await ctx.prisma.attachment.create({
      data: {
        filename: 'label.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        storagePath: 'a2/original.jpg',
        uploadedById: 'u1',
        partId: part.id,
      },
    });
    return { part, sr, att };
  }

  it('re-embeds linked service records and attachments', async () => {
    const { part, sr, att } = await seed();
    // An unrelated service record must not be swept in.
    const other = await ctx.prisma.serviceRecord.create({
      data: { summary: 'Unrelated', performedOn: todayCal() },
    });
    embedCalls.length = 0;

    await cascade.enqueuePartRenameCascade(part.id);

    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: sr.id });
    expect(embedCalls).toContainEqual({ type: 'ATTACHMENT', id: att.id });
    expect(embedCalls).not.toContainEqual({ type: 'SERVICE_RECORD', id: other.id });
    expect(embedCalls).toHaveLength(2);
  });

  it('re-indexes the service document, which denormalizes the part name', async () => {
    const { part, sr } = await seed();
    searchCalls.length = 0;

    await cascade.enqueuePartRenameCascade(part.id);

    // `targetNames` in lib/search/document.ts pushes `t.part.name`.
    expect(searchCalls).toContainEqual({ kind: 'service', id: sr.id });
  });

  it('does NOT re-index a part-attached attachment, whose document carries no part name', async () => {
    const { part, att } = await seed();
    searchCalls.length = 0;
    embedCalls.length = 0;

    await cascade.enqueuePartRenameCascade(part.id);

    // The embedding half DOES cover it ("Linked to part: …")...
    expect(embedCalls).toContainEqual({ type: 'ATTACHMENT', id: att.id });
    // ...while AttachmentRow projects only `item`, so the document is byte-for-byte
    // identical after the rename and re-indexing it is pure waste.
    expect(searchCalls.map((c) => c.id)).not.toContain(att.id);
  });

  it('updatePart fires the cascade', async () => {
    const { part, sr, att } = await seed();
    const parts = await import('@/lib/parts/actions');
    embedCalls.length = 0;

    const result = await parts.updatePart({ id: part.id, name: 'FPR 10 20x25x1 (MERV 11)' });

    expect(result.ok).toBe(true);
    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: sr.id });
    expect(embedCalls).toContainEqual({ type: 'ATTACHMENT', id: att.id });
  });
});
