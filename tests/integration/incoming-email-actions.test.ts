import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/incoming-email/actions');
let categoryId: string;

async function makeEmail(overrides: { messageId?: string } = {}) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: overrides.messageId ?? `<${Math.random()}@example.com>`,
      fromAddress: 'a@example.com',
      subject: 'Spring HVAC tune-up',
      receivedAt: new Date('2026-05-01T12:00:00Z'),
      headersJson: {},
    },
  });
}

beforeAll(async () => {
  ctx = await setupIntegration();
  actions = await import('@/lib/incoming-email/actions');
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

describe('attachIncomingEmail', () => {
  it('links to a vendor and flips state to LINKED', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme HVAC' } });
    const e = await makeEmail();
    const r = await actions.attachIncomingEmail({ id: e.id, vendorId: v.id });
    expect(r.ok).toBe(true);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.vendorId).toBe(v.id);
    expect(after?.state).toBe('LINKED');
  });

  it('clears a link when null is passed', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<clear@a>',
        fromAddress: 'a@a',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        vendorId: v.id,
      },
    });
    await actions.attachIncomingEmail({ id: e.id, vendorId: null });
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.vendorId).toBeNull();
  });

  it('rejects invalid input', async () => {
    const r = await actions.attachIncomingEmail({ id: '' });
    expect(r.ok).toBe(false);
  });
});

describe('archiveIncomingEmail / unarchiveIncomingEmail', () => {
  it('archives and sets state ARCHIVED', async () => {
    const e = await makeEmail();
    const r = await actions.archiveIncomingEmail({ id: e.id });
    expect(r.ok).toBe(true);
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.archivedAt).not.toBeNull();
    expect(after?.state).toBe('ARCHIVED');
  });

  it('unarchive restores to UNTRIAGED when no FKs are set', async () => {
    const e = await makeEmail();
    await actions.archiveIncomingEmail({ id: e.id });
    await actions.unarchiveIncomingEmail({ id: e.id });
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.archivedAt).toBeNull();
    expect(after?.state).toBe('UNTRIAGED');
  });

  it('unarchive restores to LINKED when at least one FK is set', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'V' } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<un@a>',
        fromAddress: 'a@a',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        vendorId: v.id,
        state: 'LINKED',
        archivedAt: new Date(),
      },
    });
    await actions.unarchiveIncomingEmail({ id: e.id });
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.state).toBe('LINKED');
  });
});

describe('setIncomingEmailKind', () => {
  it('updates kind', async () => {
    const e = await makeEmail();
    await actions.setIncomingEmailKind({ id: e.id, kind: 'INVOICE' });
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.kind).toBe('INVOICE');
  });
});

describe('promoteToServiceRecord', () => {
  it('creates a draft ServiceRecord with item target when itemId is set', async () => {
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<promote@a>',
        fromAddress: 'dispatch@acme',
        subject: 'Service ticket #1234',
        receivedAt: new Date('2026-05-01T12:00:00Z'),
        headersJson: {},
        vendorId: v.id,
        itemId: item.id,
        state: 'AUTO_LINKED',
      },
    });
    const r = await actions.promoteToServiceRecord({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const sr = await ctx.prisma.serviceRecord.findUnique({
      where: { id: r.data.serviceRecordId },
      include: { targets: true },
    });
    expect(sr?.summary).toBe('Service ticket #1234');
    expect(sr?.vendorId).toBe(v.id);
    expect(sr?.targets).toHaveLength(1);
    expect(sr?.targets[0].itemId).toBe(item.id);
    const updated = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(updated?.createdServiceRecordId).toBe(r.data.serviceRecordId);
    expect(updated?.state).toBe('LINKED');
  });

  it('rejects when the email already has a draft', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: new Date(), summary: 's' },
    });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<dup@a>',
        fromAddress: 'a@a',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        itemId: item.id,
        createdServiceRecordId: sr.id,
      },
    });
    const r = await actions.promoteToServiceRecord({ id: e.id });
    expect(r.ok).toBe(false);
  });

  it('rejects when no item or system is linked', async () => {
    const e = await makeEmail();
    const r = await actions.promoteToServiceRecord({ id: e.id });
    expect(r.ok).toBe(false);
  });

  it('uses the system target when only systemId is set', async () => {
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<sys@a>',
        fromAddress: 'a@a',
        subject: 'Annual tune-up',
        receivedAt: new Date(),
        headersJson: {},
        systemId: sys.id,
      },
    });
    const r = await actions.promoteToServiceRecord({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const sr = await ctx.prisma.serviceRecord.findUnique({
      where: { id: r.data.serviceRecordId },
      include: { targets: true },
    });
    expect(sr?.targets[0].systemId).toBe(sys.id);
    expect(sr?.targets[0].itemId).toBeNull();
  });

  it('prefers item target when both itemId and systemId are set', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'Y' } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<both@a>',
        fromAddress: 'a@a',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        itemId: item.id,
        systemId: sys.id,
      },
    });
    const r = await actions.promoteToServiceRecord({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const sr = await ctx.prisma.serviceRecord.findUnique({
      where: { id: r.data.serviceRecordId },
      include: { targets: true },
    });
    expect(sr?.targets[0].itemId).toBe(item.id);
    expect(sr?.targets[0].systemId).toBeNull();
  });
});

describe('queries', () => {
  it('listInboxEmails(untriaged) excludes archived rows', async () => {
    const queries = await import('@/lib/incoming-email/queries');
    await makeEmail({ messageId: '<u1@a>' });
    const archived = await makeEmail({ messageId: '<a1@a>' });
    await actions.archiveIncomingEmail({ id: archived.id });
    const untriaged = await queries.listInboxEmails({ tab: 'untriaged' });
    expect(untriaged).toHaveLength(1);
    expect(untriaged[0].state).toBe('UNTRIAGED');
    const archivedTab = await queries.listInboxEmails({ tab: 'archived' });
    expect(archivedTab).toHaveLength(1);
    expect(archivedTab[0].state).toBe('ARCHIVED');
  });

  it('countUntriagedInbox counts UNTRIAGED + AUTO_LINKED but not ARCHIVED', async () => {
    const queries = await import('@/lib/incoming-email/queries');
    await makeEmail({ messageId: '<c1@a>' });
    const auto = await makeEmail({ messageId: '<c2@a>' });
    await ctx.prisma.incomingEmail.update({
      where: { id: auto.id },
      data: { state: 'AUTO_LINKED' },
    });
    const arch = await makeEmail({ messageId: '<c3@a>' });
    await actions.archiveIncomingEmail({ id: arch.id });
    expect(await queries.countUntriagedInbox()).toBe(2);
  });
});
