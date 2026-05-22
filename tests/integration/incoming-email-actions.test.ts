import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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
  enqueued.length = 0;
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.incomingEmailTarget.deleteMany();
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

  it('clears the vendor link when null is passed', async () => {
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
    // No vendor and no targets → state reverts to UNTRIAGED.
    expect(after?.state).toBe('UNTRIAGED');
  });

  it('attaches multiple targets at once', async () => {
    const item1 = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const e = await makeEmail();
    const r = await actions.attachIncomingEmail({
      id: e.id,
      targets: [{ itemId: item1.id }, { itemId: item2.id }, { systemId: sys.id }],
    });
    expect(r.ok).toBe(true);
    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.targets).toHaveLength(3);
    expect(after?.state).toBe('LINKED');
  });

  it('replaces the target set on subsequent calls', async () => {
    const item1 = await ctx.prisma.item.create({ data: { name: 'A', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'B', categoryId } });
    const e = await makeEmail();
    await actions.attachIncomingEmail({ id: e.id, targets: [{ itemId: item1.id }] });
    await actions.attachIncomingEmail({ id: e.id, targets: [{ itemId: item2.id }] });
    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.targets).toHaveLength(1);
    expect(after?.targets[0].itemId).toBe(item2.id);
  });

  it('clears all targets when an empty array is passed', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'A', categoryId } });
    const e = await makeEmail();
    await actions.attachIncomingEmail({ id: e.id, targets: [{ itemId: item.id }] });
    await actions.attachIncomingEmail({ id: e.id, targets: [] });
    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.targets).toHaveLength(0);
    // No vendor + no targets → state reverts to UNTRIAGED.
    expect(after?.state).toBe('UNTRIAGED');
  });

  it('omitting targets leaves the existing target set unchanged', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'A', categoryId } });
    const v = await ctx.prisma.vendor.create({ data: { name: 'Acme' } });
    const e = await makeEmail();
    await actions.attachIncomingEmail({ id: e.id, targets: [{ itemId: item.id }] });
    await actions.attachIncomingEmail({ id: e.id, vendorId: v.id }); // no `targets` key
    const after = await ctx.prisma.incomingEmail.findUnique({
      where: { id: e.id },
      include: { targets: true },
    });
    expect(after?.targets).toHaveLength(1);
    expect(after?.vendorId).toBe(v.id);
  });

  it('rejects invalid input', async () => {
    const r = await actions.attachIncomingEmail({ id: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects a target row that is neither item nor system', async () => {
    const e = await makeEmail();
    const r = await actions.attachIncomingEmail({
      id: e.id,
      targets: [{ itemId: null, systemId: null }],
    });
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

  it('unarchive restores to UNTRIAGED when no links are set', async () => {
    const e = await makeEmail();
    await actions.archiveIncomingEmail({ id: e.id });
    await actions.unarchiveIncomingEmail({ id: e.id });
    const after = await ctx.prisma.incomingEmail.findUnique({ where: { id: e.id } });
    expect(after?.archivedAt).toBeNull();
    expect(after?.state).toBe('UNTRIAGED');
  });

  it('unarchive restores to LINKED when a vendor or any target is set', async () => {
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

describe('createServiceRecordFromEmail', () => {
  it('creates a draft ServiceRecord with one target per IncomingEmailTarget', async () => {
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
        state: 'AUTO_LINKED',
        targets: { create: [{ itemId: item.id }] },
      },
    });
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
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

  it('fans out N targets on the email to N targets on the new ServiceRecord', async () => {
    const item1 = await ctx.prisma.item.create({ data: { name: 'A', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'B', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'HVAC' } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<multi@a>',
        fromAddress: 'a@a',
        subject: 'Combined service visit',
        receivedAt: new Date(),
        headersJson: {},
        targets: {
          create: [{ itemId: item1.id }, { itemId: item2.id }, { systemId: sys.id }],
        },
      },
    });
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const sr = await ctx.prisma.serviceRecord.findUnique({
      where: { id: r.data.serviceRecordId },
      include: { targets: true },
    });
    expect(sr?.targets).toHaveLength(3);
    const itemIds = sr?.targets.map((t) => t.itemId).filter(Boolean);
    const systemIds = sr?.targets.map((t) => t.systemId).filter(Boolean);
    expect(itemIds).toEqual(expect.arrayContaining([item1.id, item2.id]));
    expect(systemIds).toEqual([sys.id]);
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
        createdServiceRecordId: sr.id,
        targets: { create: [{ itemId: item.id }] },
      },
    });
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
    expect(r.ok).toBe(false);
  });

  it('rejects when no targets are linked', async () => {
    const e = await makeEmail();
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
    expect(r.ok).toBe(false);
  });

  it('seeds the new service record with AI-extracted fields when present', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<ai@a>',
        fromAddress: 'a@a',
        subject: 'Invoice 142020', // generic subject, AI summary should win
        receivedAt: new Date('2026-05-01T00:00:00Z'),
        headersJson: {},
        targets: { create: [{ itemId: item.id }] },
        aiExtractedSummary: 'Spring HVAC tune-up',
        aiExtractedCost: 185 as unknown as never, // Decimal coerce
        aiExtractedPerformedOn: new Date('2026-04-15T00:00:00Z'),
        aiExtractedScope: '- Replaced filter\n- Cleaned coils',
        aiExtractedAt: new Date(),
      },
    });
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const sr = await ctx.prisma.serviceRecord.findUnique({
      where: { id: r.data.serviceRecordId },
    });
    expect(sr?.summary).toBe('Spring HVAC tune-up');
    expect(sr?.cost?.toString()).toBe('185');
    expect(sr?.performedOn.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(sr?.notes).toBe('- Replaced filter\n- Cleaned coils');
  });

  it('falls back to email subject + receivedAt when no AI extraction present', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'X', categoryId } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<noai@a>',
        fromAddress: 'a@a',
        subject: 'Service Visit Recap',
        receivedAt: new Date('2026-05-01T00:00:00Z'),
        headersJson: {},
        targets: { create: [{ itemId: item.id }] },
      },
    });
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const sr = await ctx.prisma.serviceRecord.findUnique({
      where: { id: r.data.serviceRecordId },
    });
    expect(sr?.summary).toBe('Service Visit Recap');
    expect(sr?.cost).toBeNull();
    expect(sr?.performedOn.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(sr?.notes).toContain('review and edit');
  });

  it('links existing email attachments to the new service record (multi-parent)', async () => {
    const item = await ctx.prisma.item.create({ data: { name: 'Heat Pump', categoryId } });
    const e = await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<attach@a>',
        fromAddress: 'a@a',
        subject: 'Service report',
        receivedAt: new Date(),
        headersJson: {},
        targets: { create: [{ itemId: item.id }] },
      },
    });
    const att = await ctx.prisma.attachment.create({
      data: {
        incomingEmailId: e.id,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        storagePath: 'fake/invoice.pdf',
        uploadedById: 'u1',
      },
    });
    const r = await actions.createServiceRecordFromEmail({ id: e.id });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();

    // Same attachment row, now also linked to the SR. Both FKs set
    // (multi-parent semantics).
    const after = await ctx.prisma.attachment.findUnique({ where: { id: att.id } });
    expect(after?.incomingEmailId).toBe(e.id);
    expect(after?.serviceRecordId).toBe(r.data.serviceRecordId);
    expect(after?.storagePath).toBe('fake/invoice.pdf');
  });
});

describe('reclassifyIncomingEmail', () => {
  it('enqueues a classify job for an existing email', async () => {
    const e = await makeEmail();
    const r = await actions.reclassifyIncomingEmail({ id: e.id });
    expect(r.ok).toBe(true);
    expect(enqueued).toEqual([{ queue: 'incoming-email.classify', data: { id: e.id } }]);
  });

  it('rejects when the email does not exist', async () => {
    const r = await actions.reclassifyIncomingEmail({ id: 'nope' });
    expect(r.ok).toBe(false);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects invalid input', async () => {
    const r = await actions.reclassifyIncomingEmail({ id: '' });
    expect(r.ok).toBe(false);
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

  it('list rows expose item/system target counts', async () => {
    const queries = await import('@/lib/incoming-email/queries');
    const item1 = await ctx.prisma.item.create({ data: { name: 'A', categoryId } });
    const item2 = await ctx.prisma.item.create({ data: { name: 'B', categoryId } });
    const sys = await ctx.prisma.system.create({ data: { name: 'S' } });
    await ctx.prisma.incomingEmail.create({
      data: {
        messageId: '<count@a>',
        fromAddress: 'a@a',
        subject: 's',
        receivedAt: new Date(),
        headersJson: {},
        targets: {
          create: [{ itemId: item1.id }, { itemId: item2.id }, { systemId: sys.id }],
        },
      },
    });
    const rows = await queries.listInboxEmails({ tab: 'untriaged' });
    expect(rows).toHaveLength(1);
    expect(rows[0].itemTargetCount).toBe(2);
    expect(rows[0].systemTargetCount).toBe(1);
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
