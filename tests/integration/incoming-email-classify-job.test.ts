import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

let ctx: IntegrationContext;
let handle: typeof import('@/worker/jobs/classify-incoming-email').handleClassifyIncomingEmail;
let categoryId: string;

async function makeEmail(args: {
  messageId: string;
  fromAddress: string;
  subject: string;
  bodyText?: string;
}) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: args.messageId,
      fromAddress: args.fromAddress,
      subject: args.subject,
      bodyText: args.bodyText ?? null,
      receivedAt: new Date('2026-05-08T12:00:00Z'),
      headersJson: {},
    },
  });
}

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/classify-incoming-email');
  handle = mod.handleClassifyIncomingEmail;
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 1 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

describe('handleClassifyIncomingEmail', () => {
  it('auto-stubs a ServiceRecord when kind=TICKET and vendor+item match', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme HVAC', email: 'dispatch@acme.example' },
    });
    const item = await ctx.prisma.item.create({
      data: { name: 'Heat Pump', categoryId },
    });
    const e = await makeEmail({
      messageId: '<auto1@a>',
      fromAddress: 'dispatch@acme.example',
      subject: 'Service report — Heat Pump tune-up complete',
      bodyText: 'All readings normal.',
    });

    await handle([{ data: { id: e.id } }]);

    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { createdServiceRecord: { include: { targets: true } } },
    });
    expect(after?.kind).toBe('TICKET');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.itemId).toBe(item.id);
    expect(after?.state).toBe('AUTO_LINKED');
    expect(after?.createdServiceRecord).not.toBeNull();
    expect(after?.createdServiceRecord?.summary).toBe(
      'Service report — Heat Pump tune-up complete',
    );
    expect(after?.createdServiceRecord?.targets).toHaveLength(1);
    expect(after?.createdServiceRecord?.targets[0].itemId).toBe(item.id);
  });

  it('auto-stubs against system target when only system matches', async () => {
    await ctx.prisma.vendor.create({
      data: { name: 'Acme', email: 'dispatch@acme.example' },
    });
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const e = await makeEmail({
      messageId: '<auto2@a>',
      fromAddress: 'dispatch@acme.example',
      subject: 'Service ticket — HVAC annual visit',
    });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { createdServiceRecord: { include: { targets: true } } },
    });
    expect(after?.systemId).toBe(sys.id);
    expect(after?.createdServiceRecord?.targets[0].systemId).toBe(sys.id);
    expect(after?.createdServiceRecord?.targets[0].itemId).toBeNull();
  });

  it('classifies as INVOICE without auto-stubbing (only TICKET stubs)', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme', email: 'billing@acme.example' },
    });
    await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    const e = await makeEmail({
      messageId: '<inv@a>',
      fromAddress: 'billing@acme.example',
      subject: 'Invoice #5512 for Heat Pump service',
    });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.kind).toBe('INVOICE');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.state).toBe('AUTO_LINKED');
    expect(after?.createdServiceRecordId).toBeNull();
  });

  it('leaves UNTRIAGED with no FKs when nothing matches', async () => {
    const e = await makeEmail({
      messageId: '<un@a>',
      fromAddress: 'spam@unknown.example',
      subject: 'Hello there',
    });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.kind).toBe('UNKNOWN');
    expect(after?.vendorId).toBeNull();
    expect(after?.state).toBe('UNTRIAGED');
    expect(after?.createdServiceRecordId).toBeNull();
  });

  it('handles a vendor match without item/system match (kind=TICKET, no auto-stub)', async () => {
    const v = await ctx.prisma.vendor.create({
      data: { name: 'Acme', email: 'dispatch@acme.example' },
    });
    const e = await makeEmail({
      messageId: '<vonly@a>',
      fromAddress: 'dispatch@acme.example',
      subject: 'Service report — annual visit',
    });
    await handle([{ data: { id: e.id } }]);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.kind).toBe('TICKET');
    expect(after?.vendorId).toBe(v.id);
    expect(after?.itemId).toBeNull();
    expect(after?.createdServiceRecordId).toBeNull();
  });

  it('does not double-stub when re-run on an already-stubbed row', async () => {
    await ctx.prisma.vendor.create({
      data: { name: 'Acme', email: 'dispatch@acme.example' },
    });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    const e = await makeEmail({
      messageId: '<rerun@a>',
      fromAddress: 'dispatch@acme.example',
      subject: 'Service report — Heat Pump',
    });
    // First run creates a draft.
    await handle([{ data: { id: e.id } }]);
    const after1 = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    const firstSrId = after1?.createdServiceRecordId;
    expect(firstSrId).not.toBeNull();
    // Second run must not create a second one.
    await handle([{ data: { id: e.id } }]);
    const after2 = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after2?.createdServiceRecordId).toBe(firstSrId);
    const srCount = await ctx.prisma.serviceRecord.count();
    expect(srCount).toBe(1);
    // Avoid unused-warning lint and silence type narrowing.
    void item;
  });

  it('skips a missing row without throwing', async () => {
    await expect(handle([{ data: { id: 'does-not-exist' } }])).resolves.toBeUndefined();
  });
});
