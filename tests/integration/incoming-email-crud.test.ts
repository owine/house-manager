import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.itemVendor.deleteMany();
  await ctx.prisma.systemVendor.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.category.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

describe('IncomingEmail schema', () => {
  it('inserts a row with required fields and exposes the expected defaults', async () => {
    const row = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<a@example.com>',
        fromAddress: 'sender@example.com',
        subject: 'hi',
        receivedAt: new Date('2026-05-08T12:00:00Z'),
        headersJson: { 'x-foo': 'bar' },
      },
    });
    expect(row.kind).toBe('UNKNOWN');
    expect(row.state).toBe('UNTRIAGED');
    expect(row.archivedAt).toBeNull();
    expect(row.bodyText).toBeNull();
  });

  it('rejects a duplicate messageId', async () => {
    await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<dup@example.com>',
        fromAddress: 'a@example.com',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
      },
    });
    await expect(
      ctx.prisma.incomingEmail.create({
        data: {
          messageId: '<dup@example.com>',
          fromAddress: 'b@example.com',
          subject: 's2',
          receivedAt: new Date(),
          headersJson: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('clears vendorId when the linked Vendor is deleted (SetNull)', async () => {
    const vendor = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    const row = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<vendor-link@example.com>',
        fromAddress: 'dispatch@acme.example',
        subject: 'service report',
        receivedAt: new Date(),
        headersJson: {},
        vendorId: vendor.id,
      },
    });
    await ctx.prisma.vendor.delete({ where: { id: vendor.id } });
    const reread = await ctx.prisma.incomingEmail.findUnique({ where: { id: row.id } });
    expect(reread?.vendorId).toBeNull();
  });

  it('cascades attachment deletion when the email is deleted', async () => {
    const email = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<with-attachment@example.com>',
        fromAddress: 'a@example.com',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
      },
    });
    const attachment = await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: email.id,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        storagePath: 'fake/path.pdf',
        uploadedById: 'u1',
      },
    });
    await ctx.prisma.incomingEmail.delete({ where: { id: email.id } });
    const orphan = await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } });
    expect(orphan).toBeNull();
  });

  it('enforces createdServiceRecordId uniqueness (one email per ServiceRecord)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: todayCal(), summary: 'tune-up' },
    });
    await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<first@example.com>',
        fromAddress: 'a@example.com',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        createdServiceRecordId: sr.id,
      },
    });
    await expect(
      ctx.prisma.incomingEmail.create({
        data: {
          messageId: '<second@example.com>',
          fromAddress: 'b@example.com',
          subject: 's2',
          receivedAt: new Date(),
          headersJson: {},
          createdServiceRecordId: sr.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows an attachment with multiple parent FKs (multi-parent supported)', async () => {
    // The exactly-one-parent CHECK was dropped to support inbox→service-record
    // promotion: the same PDF needs to live in both contexts simultaneously.
    const email = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<two-parents@example.com>',
        fromAddress: 'a@example.com',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
      },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: todayCal(), summary: 's' },
    });
    const a = await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: email.id,
        serviceRecordId: sr.id,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storagePath: 'fake/invoice.pdf',
        uploadedById: 'u1',
      },
    });
    expect(a.incomingEmailId).toBe(email.id);
    expect(a.serviceRecordId).toBe(sr.id);
  });

  it('clears createdServiceRecordId when the linked ServiceRecord is deleted (SetNull)', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: todayCal(), summary: 's' },
    });
    const email = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<sr-link@example.com>',
        fromAddress: 'a@example.com',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        createdServiceRecordId: sr.id,
      },
    });
    await ctx.prisma.serviceRecord.delete({ where: { id: sr.id } });
    const reread = await ctx.prisma.incomingEmail.findUnique({ where: { id: email.id } });
    expect(reread?.createdServiceRecordId).toBeNull();
  });
});
