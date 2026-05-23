import { prisma } from '@/lib/db';
import { enqueueEmbed } from './enqueue';

/**
 * Parent-rename cascade helpers for the Ask/RAG embedding pipeline.
 *
 * Several entity types denormalize parent names into their canonical embed
 * text (see lib/embedding/index.ts buildCanonical). When the parent is
 * renamed, the child embeddings keep the stale name forever — Ask would
 * still match queries against the old name. These helpers enqueue a
 * re-embed for every affected child after a rename.
 *
 * Design notes:
 *   - The embed worker hashes canonical text and skips no-op re-embeds, so
 *     calling these unconditionally on every update (not just renames) is
 *     safe and cheap. The trade is one extra query batch per write.
 *   - enqueueEmbed itself is a fire-and-forget pg-boss send; failures are
 *     logged and swallowed (see lib/embedding/enqueue.ts), so a cascade
 *     fan-out can't break the user's mutation.
 *   - Not covered yet (smaller surface): Checklist.name → CHECKLIST_ITEM,
 *     ServiceRecord.summary → ATTACHMENT (via serviceRecordId),
 *     Warranty.provider → ATTACHMENT (via warrantyId),
 *     Note.title → ATTACHMENT (via noteId). Add helpers here when those
 *     rename paths become user-facing.
 */

/**
 * Item.name flows into: NOTE, SERVICE_RECORD (via ServiceTarget),
 * CHECKLIST_ITEM (direct itemId), WARRANTY (via WarrantyTarget),
 * ATTACHMENT (direct itemId).
 */
export async function enqueueItemRenameCascade(itemId: string): Promise<void> {
  const [notes, services, checklistItems, warranties, attachments] = await Promise.all([
    prisma.note.findMany({ where: { itemId }, select: { id: true } }),
    prisma.serviceRecord.findMany({
      where: { targets: { some: { itemId } } },
      select: { id: true },
    }),
    prisma.checklistItem.findMany({ where: { itemId }, select: { id: true } }),
    prisma.warranty.findMany({
      where: { targets: { some: { itemId } } },
      select: { id: true },
    }),
    prisma.attachment.findMany({ where: { itemId }, select: { id: true } }),
  ]);
  await Promise.all([
    ...notes.map((n) => enqueueEmbed('NOTE', n.id)),
    ...services.map((s) => enqueueEmbed('SERVICE_RECORD', s.id)),
    ...checklistItems.map((c) => enqueueEmbed('CHECKLIST_ITEM', c.id)),
    ...warranties.map((w) => enqueueEmbed('WARRANTY', w.id)),
    ...attachments.map((a) => enqueueEmbed('ATTACHMENT', a.id)),
  ]);
}

/**
 * Vendor.name flows into: SERVICE_RECORD (direct vendorId).
 */
export async function enqueueVendorRenameCascade(vendorId: string): Promise<void> {
  const services = await prisma.serviceRecord.findMany({
    where: { vendorId },
    select: { id: true },
  });
  await Promise.all(services.map((s) => enqueueEmbed('SERVICE_RECORD', s.id)));
}

/**
 * System.name flows into: ITEM (direct systemId), SERVICE_RECORD (via
 * ServiceTarget.systemId), WARRANTY (via WarrantyTarget.systemId).
 */
export async function enqueueSystemRenameCascade(systemId: string): Promise<void> {
  const [items, services, warranties] = await Promise.all([
    prisma.item.findMany({ where: { systemId }, select: { id: true } }),
    prisma.serviceRecord.findMany({
      where: { targets: { some: { systemId } } },
      select: { id: true },
    }),
    prisma.warranty.findMany({
      where: { targets: { some: { systemId } } },
      select: { id: true },
    }),
  ]);
  await Promise.all([
    ...items.map((i) => enqueueEmbed('ITEM', i.id)),
    ...services.map((s) => enqueueEmbed('SERVICE_RECORD', s.id)),
    ...warranties.map((w) => enqueueEmbed('WARRANTY', w.id)),
  ]);
}
