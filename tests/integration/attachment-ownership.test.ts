import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite } from '@/lib/attachments/storage';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', name: 'Test' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Only FILES_DIR is read on these paths (same narrowing as part-attachments.test.ts).
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ FILES_DIR: process.env.FILES_DIR }),
}));

vi.mock('@/lib/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/queue')>();
  return { ...orig, getBoss: vi.fn(async () => ({ send: vi.fn(async () => 'fake-job-id') })) };
});

const searchCalls: { kind: string; id: string; op: string }[] = [];
vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async (kind: string, id: string, op: string) => {
    searchCalls.push({ kind, id, op });
  }),
}));
vi.mock('@/lib/embedding/enqueue', () => ({ enqueueEmbed: vi.fn(async () => {}) }));

let ctx: IntegrationContext;
let attachments: typeof import('@/lib/attachments/actions');
let serviceRecords: typeof import('@/lib/service-records/actions');
let inbox: typeof import('@/lib/incoming-email/actions');
let filesDir: string;
const originalFilesDir = process.env.FILES_DIR;

beforeAll(async () => {
  ctx = await setupIntegration();
  filesDir = await mkdtemp(`${tmpdir()}/attachment-ownership-`);
  process.env.FILES_DIR = filesDir;
  attachments = await import('@/lib/attachments/actions');
  serviceRecords = await import('@/lib/service-records/actions');
  inbox = await import('@/lib/incoming-email/actions');
}, 180_000);

afterAll(async () => {
  process.env.FILES_DIR = originalFilesDir;
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  searchCalls.length = 0;
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.incomingEmail.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.vendor.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function makeEmail(vendorId: string | null = null) {
  return ctx.prisma.incomingEmail.create({
    data: {
      messageId: `<${createId()}@example.com>`,
      fromAddress: 'billing@acme.example',
      subject: 'Invoice #1042',
      receivedAt: new Date('2026-05-01T12:00:00Z'),
      headersJson: {},
      vendorId,
    },
  });
}

/** Mirrors ingest.ts's layout: one `inbound/<xx>/<cuid>` directory per file. */
async function seedInboundAttachment(incomingEmailId: string) {
  const cuid = createId();
  const dirRel = `inbound/${cuid.slice(0, 2)}/${cuid}`;
  const storagePath = await atomicWrite(
    filesDir,
    dirRel,
    'invoice.pdf',
    Buffer.from('%PDF-1.4 test'),
  );
  const attachment = await ctx.prisma.attachment.create({
    data: {
      incomingEmailId,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 13,
      storagePath,
      uploadedById: 'u1',
    },
  });
  return {
    attachment,
    fileAbs: join(filesDir, storagePath),
    dirAbs: join(filesDir, dirRel),
  };
}

describe('deleteAttachment removes the directory the file actually lives in', () => {
  it("removes an inbound attachment's inbound/<xx>/<cuid> directory", async () => {
    const email = await makeEmail();
    const { attachment, dirAbs } = await seedInboundAttachment(email.id);

    const r = await attachments.deleteAttachment(attachment.id);

    expect(r).toEqual({ ok: true, data: undefined });
    expect(await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } })).toBeNull();
    expect(await exists(dirAbs)).toBe(false);
    expect(searchCalls).toContainEqual({ kind: 'attachment', id: attachment.id, op: 'delete' });
  });

  it("still removes an uploaded attachment's <id> directory, thumbnail included", async () => {
    const part = await ctx.prisma.part.create({ data: { name: 'Anode rod', kind: 'OTHER' } });
    const id = createId();
    const storagePath = await atomicWrite(filesDir, id, 'original.jpg', Buffer.from('jpg'));
    const thumbnailPath = await atomicWrite(filesDir, id, 'thumb.webp', Buffer.from('webp'));
    await ctx.prisma.attachment.create({
      data: {
        id,
        partId: part.id,
        filename: 'anode.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        storagePath,
        thumbnailPath,
        uploadedById: 'u1',
      },
    });

    const r = await attachments.deleteAttachment(id);

    expect(r.ok).toBe(true);
    expect(await exists(join(filesDir, id))).toBe(false);
  });

  it("never touches a sibling's file when two rows share a malformed ancestor directory", async () => {
    const email = await makeEmail();
    // Malformed on purpose: both files live directly under `inbound/xx`, the
    // shared bucket dir ingest.ts never itself writes into. This is the shape
    // attachmentStorageDirs must report as unrecognized rather than delete.
    const dirRel = 'inbound/xx';
    const pathA = await atomicWrite(filesDir, dirRel, 'a.pdf', Buffer.from('a'));
    const pathB = await atomicWrite(filesDir, dirRel, 'b.pdf', Buffer.from('b'));

    const [attA, attB] = await Promise.all([
      ctx.prisma.attachment.create({
        data: {
          incomingEmailId: email.id,
          filename: 'a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
          storagePath: pathA,
          uploadedById: 'u1',
        },
      }),
      ctx.prisma.attachment.create({
        data: {
          incomingEmailId: email.id,
          filename: 'b.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
          storagePath: pathB,
          uploadedById: 'u1',
        },
      }),
    ]);

    const r = await attachments.deleteAttachment(attA.id);

    expect(r).toEqual({ ok: true, data: undefined });
    expect(await ctx.prisma.attachment.findUnique({ where: { id: attA.id } })).toBeNull();
    // The sibling row and its file must survive: the shared `inbound/xx`
    // directory was never removed.
    expect(await ctx.prisma.attachment.findUnique({ where: { id: attB.id } })).not.toBeNull();
    expect(await exists(join(filesDir, pathB))).toBe(true);
  });
});

/**
 * Drafts a service record through the real "Create service record" action.
 * The worker's autoStub goes through the same createServiceRecordForEmail
 * helper, so this covers both creation paths.
 */
async function draftFromEmail() {
  const vendor = await ctx.prisma.vendor.create({ data: { name: `Acme ${createId()}` } });
  const email = await makeEmail(vendor.id);
  const seeded = await seedInboundAttachment(email.id);
  const r = await inbox.createServiceRecordFromEmail({ id: email.id });
  if (!r.ok) throw new Error(`draft failed: ${JSON.stringify(r)}`);
  const linked = await ctx.prisma.attachment.findUniqueOrThrow({
    where: { id: seeded.attachment.id },
  });
  expect(linked.serviceRecordId).toBe(r.data.serviceRecordId); // precondition
  return { email, serviceRecordId: r.data.serviceRecordId, ...seeded };
}

describe('an inbound attachment is owned by its email, not by the drafted service record', () => {
  it("deleting the draft keeps the email's attachment row and its file", async () => {
    const { email, serviceRecordId, attachment, fileAbs } = await draftFromEmail();

    const r = await serviceRecords.deleteServiceRecord(serviceRecordId);

    expect(r).toEqual({ ok: true, data: undefined });
    expect(
      await ctx.prisma.serviceRecord.findUnique({ where: { id: serviceRecordId } }),
    ).toBeNull();
    const after = await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } });
    expect(after).not.toBeNull();
    expect(after?.incomingEmailId).toBe(email.id);
    expect(after?.serviceRecordId).toBeNull();
    expect(await exists(fileAbs)).toBe(true);
    // Its search parent moved from the record back to the email.
    expect(searchCalls).toContainEqual({ kind: 'attachment', id: attachment.id, op: 'upsert' });
  });

  it('re-drafting after deleting the draft re-links the same attachment', async () => {
    const { email, serviceRecordId, attachment } = await draftFromEmail();
    await serviceRecords.deleteServiceRecord(serviceRecordId);

    const again = await inbox.createServiceRecordFromEmail({ id: email.id });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const after = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
    expect(after.serviceRecordId).toBe(again.data.serviceRecordId);
  });

  it('an attachment uploaded straight to the record still goes with it', async () => {
    const { serviceRecordId } = await draftFromEmail();
    const own = await ctx.prisma.attachment.create({
      data: {
        serviceRecordId,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        storagePath: `${createId()}/original.jpg`,
        uploadedById: 'u1',
      },
    });

    await serviceRecords.deleteServiceRecord(serviceRecordId);

    expect(await ctx.prisma.attachment.findUnique({ where: { id: own.id } })).toBeNull();
  });

  it('"delete" on the service-record page unlinks an email-owned attachment instead of destroying it', async () => {
    const { email, attachment, fileAbs } = await draftFromEmail();

    const r = await attachments.deleteAttachment(attachment.id);

    expect(r).toEqual({ ok: true, data: undefined });
    const after = await ctx.prisma.attachment.findUnique({ where: { id: attachment.id } });
    expect(after).not.toBeNull();
    expect(after?.incomingEmailId).toBe(email.id);
    expect(after?.serviceRecordId).toBeNull();
    expect(await exists(fileAbs)).toBe(true);
    expect(searchCalls).toContainEqual({ kind: 'attachment', id: attachment.id, op: 'upsert' });
    expect(searchCalls).not.toContainEqual({
      kind: 'attachment',
      id: attachment.id,
      op: 'delete',
    });
  });
});
