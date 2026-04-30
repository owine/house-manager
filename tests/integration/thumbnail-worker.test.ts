import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '@/lib/attachments/storage';
import { handleThumbnail } from '@/worker/jobs/thumbnail';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let filesDir: string;
const originalFilesDir = process.env.FILES_DIR;

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = await mkdtemp(`${tmpdir()}/files-`);
  process.env.FILES_DIR = filesDir;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  process.env.FILES_DIR = originalFilesDir;
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
  itemId = item.id;
});

describe('handleThumbnail', () => {
  it('produces a thumb.webp and updates thumbnailPath', async () => {
    const fixture = await readFile('tests/fixtures/sample.jpg');
    const id = 'attach-1';
    await atomicWrite(filesDir, id, 'original.jpg', fixture);
    await ctx.prisma.attachment.create({
      data: {
        id,
        filename: 'sample.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: fixture.length,
        storagePath: `${id}/original.jpg`,
        uploadedById: 'u1',
        itemId,
      },
    });

    await handleThumbnail({ attachmentId: id }, ctx.prisma);

    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.thumbnailPath).toBe(`${id}/thumb.webp`);
    const thumb = await readFile(`${filesDir}/${id}/thumb.webp`);
    expect(thumb.length).toBeGreaterThan(0);
  });

  it('is idempotent — second call is a no-op', async () => {
    const fixture = await readFile('tests/fixtures/sample.jpg');
    const id = 'attach-2';
    await atomicWrite(filesDir, id, 'original.jpg', fixture);
    await ctx.prisma.attachment.create({
      data: {
        id,
        filename: 'sample.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: fixture.length,
        storagePath: `${id}/original.jpg`,
        uploadedById: 'u1',
        itemId,
      },
    });
    await handleThumbnail({ attachmentId: id }, ctx.prisma);
    await handleThumbnail({ attachmentId: id }, ctx.prisma); // no-op
    const row = await ctx.prisma.attachment.findUnique({ where: { id } });
    expect(row?.thumbnailPath).toBe(`${id}/thumb.webp`);
  });
});
