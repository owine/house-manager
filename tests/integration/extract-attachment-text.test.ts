import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from '@/lib/attachments/storage';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Mutable so the env mock can read the runtime tmpdir set in beforeAll.
let filesDirRef = '';
const enqueueEmbedMock = vi.fn(
  async (_entityType: unknown, _entityId?: unknown, _opts?: unknown) => {},
);
const ocrMock = vi.fn(async (_buf: Buffer) => 'OCR_TEXT');
const renderMock = vi.fn(async (_buf: Buffer) => [Buffer.from('png-page')]);
const extractPdfTextMock = vi.fn(async (_buf: Buffer) => ({ text: '' }));
const normalizeMock = vi.fn(async (_buf: Buffer) => Buffer.from('normalized-png') as Buffer | null);

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ ASK_ENABLED: true, OCR_BACKEND: 'none', FILES_DIR: filesDirRef })),
}));
vi.mock('@/lib/ocr/tesseract', () => ({ ocrImageBuffer: (b: Buffer) => ocrMock(b) }));
vi.mock('@/lib/pdf/render', () => ({ renderPdfPagesToPng: (b: Buffer) => renderMock(b) }));
vi.mock('@/lib/pdf/text', () => ({ extractPdfText: (b: Buffer) => extractPdfTextMock(b) }));
vi.mock('@/lib/ocr/normalize-image', () => ({
  normalizeImageForOcr: (b: Buffer) => normalizeMock(b),
}));
vi.mock('@/lib/embedding/enqueue', () => ({
  enqueueEmbed: (entityType: unknown, entityId: unknown, opts?: unknown) =>
    enqueueEmbedMock(entityType, entityId, opts),
}));

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let handleExtractAttachmentText: typeof import('@/worker/jobs/extract-attachment-text').handleExtractAttachmentText;

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDirRef = await mkdtemp(`${tmpdir()}/files-`);
  handleExtractAttachmentText = (await import('@/worker/jobs/extract-attachment-text'))
    .handleExtractAttachmentText;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'extract-cat' },
    create: { slug: 'extract-cat', name: 'ExtractCat', sortOrder: 999 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-establish default mock return values cleared by clearAllMocks:
  ocrMock.mockResolvedValue('OCR_TEXT');
  renderMock.mockResolvedValue([Buffer.from('png-page')]);
  extractPdfTextMock.mockResolvedValue({ text: '' });
  normalizeMock.mockResolvedValue(Buffer.from('normalized-png'));
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
  itemId = item.id;
});

async function seedAttachment(
  id: string,
  mimeType: string,
  content = 'placeholder',
): Promise<void> {
  await atomicWrite(filesDirRef, id, 'original', Buffer.from(content));
  await ctx.prisma.attachment.create({
    data: {
      id,
      filename: 'f',
      mimeType,
      sizeBytes: content.length,
      storagePath: `${id}/original`,
      uploadedById: 'u1',
      itemId,
    },
  });
}

describe('handleExtractAttachmentText', () => {
  it('text-layer PDF: uses extracted text without OCR', async () => {
    const longText = 'x'.repeat(300);
    extractPdfTextMock.mockResolvedValue({ text: longText });
    const id = 'pdf-text-layer';
    await seedAttachment(id, 'application/pdf');

    await handleExtractAttachmentText([{ data: { attachmentId: id } }]);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.extractedText).toBe(longText);
    expect(renderMock).not.toHaveBeenCalled();
    expect(row?.ocrUsed).toBe(false);
  });

  it('scanned PDF: falls back to render + OCR when text layer is short', async () => {
    extractPdfTextMock.mockResolvedValue({ text: 'short' });
    const id = 'pdf-scanned';
    await seedAttachment(id, 'application/pdf');

    await handleExtractAttachmentText([{ data: { attachmentId: id } }]);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(renderMock).toHaveBeenCalled();
    expect(ocrMock).toHaveBeenCalled();
    expect(row?.extractedText).toContain('OCR_TEXT');
    expect(row?.ocrUsed).toBe(true);
  });

  it('image decodable: normalizes via sharp then OCRs the normalized buffer', async () => {
    const id = 'img-decodable';
    await seedAttachment(id, 'image/jpeg');

    await handleExtractAttachmentText([{ data: { attachmentId: id } }]);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(normalizeMock).toHaveBeenCalled();
    // OCR should receive the normalized buffer, not the raw buffer
    expect(ocrMock).toHaveBeenCalledWith(Buffer.from('normalized-png'));
    expect(row?.extractedText).toBe('OCR_TEXT');
    expect(row?.ocrUsed).toBe(true);
    expect(enqueueEmbedMock).toHaveBeenCalledWith('ATTACHMENT', id, undefined);
  });

  it('image undecodable: sets image_decode_failed; skips OCR and embed', async () => {
    normalizeMock.mockResolvedValue(null);
    const id = 'img-undecodable';
    await seedAttachment(id, 'image/png');

    await handleExtractAttachmentText([{ data: { attachmentId: id } }]);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.extractedError).toBe('image_decode_failed');
    expect(ocrMock).not.toHaveBeenCalled();
    expect(enqueueEmbedMock).not.toHaveBeenCalled();
  });

  it('text/plain: reads the file content directly', async () => {
    const id = 'text-plain';
    await seedAttachment(id, 'text/plain', 'hello world');

    await handleExtractAttachmentText([{ data: { attachmentId: id } }]);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.extractedText).toBe('hello world');
  });

  it('unsupported mime: sets extractedError starting with unsupported_mime:', async () => {
    const id = 'unsupported-mime';
    await seedAttachment(id, 'application/zip');

    await handleExtractAttachmentText([{ data: { attachmentId: id } }]);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.extractedError).toMatch(/^unsupported_mime:/);
  });
});
