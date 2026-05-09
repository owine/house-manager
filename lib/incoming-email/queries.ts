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
  itemTargetCount: number;
  systemTargetCount: number;
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
      _count: { select: { attachments: true } },
      targets: { select: { itemId: true, systemId: true } },
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
    itemTargetCount: r.targets.filter((t) => t.itemId !== null).length,
    systemTargetCount: r.targets.filter((t) => t.systemId !== null).length,
    attachmentCount: r._count.attachments,
  }));
}

export async function getInboxEmail(id: string) {
  return prisma.incomingEmail.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, name: true } },
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
      targets: {
        select: {
          id: true,
          itemId: true,
          systemId: true,
          item: { select: { id: true, name: true } },
          system: { select: { id: true, name: true } },
        },
      },
    },
  });
}

export type ExtractionView = {
  summary: string | null;
  cost: number | null;
  performedOn: Date | null;
  scope: string | null;
  extractedAt: Date | null;
};

/**
 * Pulls just the extraction fields, decoded for the UI. Decimal → number
 * conversion happens here so the component can stay a server tree without
 * pulling in Decimal.js.
 */
export function selectExtraction(row: {
  aiExtractedSummary: string | null;
  aiExtractedCost: { toNumber(): number } | null;
  aiExtractedPerformedOn: Date | null;
  aiExtractedScope: string | null;
  aiExtractedAt: Date | null;
}): ExtractionView {
  return {
    summary: row.aiExtractedSummary,
    cost: row.aiExtractedCost?.toNumber() ?? null,
    performedOn: row.aiExtractedPerformedOn,
    scope: row.aiExtractedScope,
    extractedAt: row.aiExtractedAt,
  };
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
      select: {
        id: true,
        name: true,
        archivedAt: true,
        category: { select: { name: true } },
      },
    }),
    prisma.system.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        kind: true,
        items: { select: { id: true, archivedAt: true } },
      },
    }),
  ]);
  // Reshape items to the AvailableItem shape <TargetsPicker> expects.
  return {
    vendors,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      categoryName: i.category?.name ?? null,
      archivedAt: i.archivedAt,
    })),
    systems,
  };
}
