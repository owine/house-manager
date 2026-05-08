import { prisma } from '@/lib/db';

export type InboxTab = 'untriaged' | 'archived';

export type InboxRow = {
  id: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  receivedAt: Date;
  kind: 'ESTIMATE' | 'INVOICE' | 'TICKET' | 'UNKNOWN';
  state: 'UNTRIAGED' | 'AUTO_LINKED' | 'LINKED' | 'ARCHIVED';
  archivedAt: Date | null;
  hasVendor: boolean;
  hasItem: boolean;
  hasSystem: boolean;
  attachmentCount: number;
};

const PAGE_DEFAULT = 50;

export async function listInboxEmails(
  opts: { tab: InboxTab; skip?: number; take?: number } = { tab: 'untriaged' },
): Promise<InboxRow[]> {
  const where =
    opts.tab === 'untriaged'
      ? { archivedAt: null, state: { in: ['UNTRIAGED' as const, 'AUTO_LINKED' as const] } }
      : { archivedAt: { not: null } };
  const rows = await prisma.incomingEmail.findMany({
    where,
    orderBy: { receivedAt: 'desc' },
    skip: opts.skip ?? 0,
    take: opts.take ?? PAGE_DEFAULT,
    select: {
      id: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      receivedAt: true,
      kind: true,
      state: true,
      archivedAt: true,
      vendorId: true,
      itemId: true,
      systemId: true,
      _count: { select: { attachments: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    fromAddress: r.fromAddress,
    fromName: r.fromName,
    subject: r.subject,
    receivedAt: r.receivedAt,
    kind: r.kind,
    state: r.state,
    archivedAt: r.archivedAt,
    hasVendor: r.vendorId !== null,
    hasItem: r.itemId !== null,
    hasSystem: r.systemId !== null,
    attachmentCount: r._count.attachments,
  }));
}

export async function getInboxEmail(id: string) {
  return prisma.incomingEmail.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, name: true } },
      item: { select: { id: true, name: true } },
      system: { select: { id: true, name: true } },
      attachments: {
        select: {
          id: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          storagePath: true,
        },
      },
      createdServiceRecord: { select: { id: true, summary: true } },
    },
  });
}

/**
 * Cheap count for the sidebar badge. UNTRIAGED + AUTO_LINKED are both "needs
 * attention" from the user's perspective.
 */
export async function countUntriagedInbox(): Promise<number> {
  return prisma.incomingEmail.count({
    where: { archivedAt: null, state: { in: ['UNTRIAGED', 'AUTO_LINKED'] } },
  });
}

/** Picker data for the LinkPicker — small, no need to paginate at this scale. */
export async function loadLinkPickerOptions() {
  const [vendors, items, systems] = await Promise.all([
    prisma.vendor.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.item.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.system.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return { vendors, items, systems };
}
