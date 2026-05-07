import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.warranty.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  // A user record is required because Attachment.uploadedById FKs to User.
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'test-user', email: 'test@example.com', name: 'Test User' },
  });
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

describe('Attachment CHECK constraint', () => {
  it('rejects an INSERT with all four FKs null', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, filename, "mimeType", "sizeBytes", "storagePath", "uploadedById", "createdAt", "aiIndexable")
        VALUES
          ('a-1', 'x.pdf', 'application/pdf', 1, 'a-1/original.pdf', 'test-user', NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_exactly_one_parent/);
  });

  it('rejects an INSERT with two FKs set', async () => {
    const w = await ctx.prisma.warranty.create({
      data: {
        itemId,
        provider: 'Acme',
        startsOn: new Date(),
        endsOn: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, filename, "mimeType", "sizeBytes", "storagePath", "uploadedById",
           "itemId", "warrantyId", "createdAt", "aiIndexable")
        VALUES
          ('a-2', 'x.pdf', 'application/pdf', 1, 'a-2/original.pdf', 'test-user',
           ${itemId}, ${w.id}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_exactly_one_parent/);
  });

  it('accepts an INSERT with exactly one FK set', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storagePath: 'placeholder/original.pdf',
        uploadedById: 'test-user',
        itemId,
      },
    });
    expect(a.itemId).toBe(itemId);
  });
});

describe('Attachment cascade', () => {
  it('cascade-deletes when the parent Item is hard-deleted', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storagePath: 'a/original.pdf',
        uploadedById: 'test-user',
        itemId,
      },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: a.id } });
    expect(orphan).toBeNull();
  });

  it('cascade-deletes when the parent ServiceRecord is hard-deleted', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: {
        performedOn: new Date(),
        summary: 'tune-up',
        targets: { create: [{ itemId }] },
      },
    });
    const a = await ctx.prisma.attachment.create({
      data: {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storagePath: 'b/original.pdf',
        uploadedById: 'test-user',
        serviceRecordId: sr.id,
      },
    });
    await ctx.prisma.serviceRecord.delete({ where: { id: sr.id } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: a.id } });
    expect(orphan).toBeNull();
  });
});

describe('Attachment storage xor link CHECK', () => {
  it('rejects an INSERT with neither storagePath nor externalUrl', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, "uploadedById", "itemId", "createdAt", "aiIndexable")
        VALUES
          ('xor-1', 'test-user', ${itemId}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_storage_xor_link/);
  });

  it('rejects an INSERT with both storagePath AND externalUrl', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, filename, "mimeType", "sizeBytes", "storagePath", "externalUrl",
           "uploadedById", "itemId", "createdAt", "aiIndexable")
        VALUES
          ('xor-2', 'x.pdf', 'application/pdf', 1, 'xor-2/original.pdf',
           'https://example.com/x', 'test-user', ${itemId}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_storage_xor_link/);
  });

  it('accepts an INSERT with only externalUrl set (link row)', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        externalUrl: 'https://example.com/manual.pdf',
        displayLabel: 'Manual',
        uploadedById: 'test-user',
        itemId,
      },
    });
    expect(a.externalUrl).toBe('https://example.com/manual.pdf');
    expect(a.storagePath).toBeNull();
  });
});

describe('Attachment file metadata required CHECK', () => {
  it('rejects an INSERT with storagePath set but filename NULL', async () => {
    await expect(
      ctx.prisma.$executeRaw`
        INSERT INTO "attachments"
          (id, "mimeType", "sizeBytes", "storagePath", "uploadedById",
           "itemId", "createdAt", "aiIndexable")
        VALUES
          ('meta-1', 'application/pdf', 1, 'meta-1/original.pdf',
           'test-user', ${itemId}, NOW(), true);
      `,
    ).rejects.toThrow(/Attachment_file_metadata_required/);
  });

  it('accepts a link row with filename populated (future Drive picker)', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        externalUrl: 'https://drive.example/x',
        filename: 'Future Drive File.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12345,
        uploadedById: 'test-user',
        itemId,
      },
    });
    expect(a.filename).toBe('Future Drive File.pdf');
    expect(a.storagePath).toBeNull();
  });
});

describe('Link row cascade', () => {
  it('cascade-deletes a link row when its parent Item is hard-deleted', async () => {
    const a = await ctx.prisma.attachment.create({
      data: {
        externalUrl: 'https://example.com/x',
        uploadedById: 'test-user',
        itemId,
      },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: a.id } });
    expect(orphan).toBeNull();
  });
});
