import { prisma } from '@/lib/db';
import { enqueueEmbed } from '@/lib/embedding/enqueue';
import { enqueueSearchIndex } from '@/lib/search/client';

/**
 * Parent-rename cascade helpers for BOTH derived pipelines — Ask/RAG
 * embeddings and the Meilisearch index.
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
 *
 * ## The two pipelines need DIFFERENT membership
 *
 * They overlap on four entities and diverge on three, because they answer
 * different questions: embeddings cover "what gets embedded", search covers
 * "whose document denormalizes a name". Keep both lists in this one file so
 * the divergence is visible rather than discovered.
 *
 * | entity     | embedding | search doc carries a parent name |
 * |------------|-----------|----------------------------------|
 * | note       | yes       | yes                              |
 * | service    | yes       | yes                              |
 * | attachment | yes       | yes                              |
 * | part       | yes       | yes (item AND system, via parentNames) |
 * | checklist  | yes (CHECKLIST_ITEM) | NO — its doc hardcodes itemName: '' |
 * | warranty   | yes       | n/a — not a SearchKind           |
 * | reminder   | NO — there is no REMINDER embedding type | yes |
 *
 * Bolting `enqueueSearchIndex` beside each `enqueueEmbed` would therefore miss
 * reminders and pointlessly re-index checklists.
 *
 * A **part** rename has its own asymmetry, in the same spirit. Part.name is
 * denormalized into exactly two derived surfaces:
 *
 * | consumer of Part.name        | embedding | search doc carries the part name |
 * |------------------------------|-----------|----------------------------------|
 * | service record (ServiceTarget.partId) | yes — canonicalizeServiceRecord's `targetNames` | yes — the service document's `targetNames` pushes `t.part.name` |
 * | attachment (Attachment.partId)        | yes — "Linked to part: …" | yes — AttachmentRow's `parent` resolves whichever FK is set, so a part-attached file's `itemName` is the part's name |
 *
 * So both consumers go to both halves. Reminders are absent from both: a
 * reminder targeting a part is not embedded (no REMINDER type) *and* its
 * search document reads only its first item target, never a part.
 *
 * A **system** rename reaches only parts, whose `parentNames` joins item and
 * system names. A **vendor** rename reaches no search document at all — a
 * service record's body is its notes, not its vendor.
 *
 *   - Not covered yet (smaller surface): Checklist.name → CHECKLIST_ITEM,
 *     ServiceRecord.summary → ATTACHMENT (via serviceRecordId),
 *     Warranty.provider → ATTACHMENT (via warrantyId),
 *     Note.title → ATTACHMENT (via noteId). Add helpers here when those
 *     rename paths become user-facing. Those three now leave a stale *search*
 *     document as well as a stale embedding: the attachment document's
 *     `itemName` reads whichever parent is set, so renaming a note, warranty
 *     or service record leaves its attached files findable only by the old
 *     name until the nightly search.reindex rebuilds the index.
 */

/**
 * Item.name flows into: NOTE, SERVICE_RECORD (via ServiceTarget),
 * CHECKLIST_ITEM (direct itemId), WARRANTY (via WarrantyTarget),
 * ATTACHMENT (direct itemId), PART (via PartLink).
 */
export async function enqueueItemRenameCascade(itemId: string): Promise<void> {
  const [notes, services, checklistItems, warranties, attachments, parts, reminders] =
    await Promise.all([
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
      // canonicalizePart denormalizes its parents' names ("Installed in: …"),
      // so a rename leaves every linked part answering with the old fixture.
      prisma.part.findMany({ where: { links: { some: { itemId } } }, select: { id: true } }),
      // Search only: reminder documents carry `itemName` but reminders are not
      // embedded, so this set exists for the index alone.
      prisma.reminderTarget.findMany({
        where: { itemId },
        select: { reminderId: true },
      }),
    ]);
  const reminderIds = [...new Set(reminders.map((t) => t.reminderId))];
  await Promise.all([
    ...notes.map((n) => enqueueEmbed('NOTE', n.id)),
    ...services.map((s) => enqueueEmbed('SERVICE_RECORD', s.id)),
    ...checklistItems.map((c) => enqueueEmbed('CHECKLIST_ITEM', c.id)),
    ...warranties.map((w) => enqueueEmbed('WARRANTY', w.id)),
    ...attachments.map((a) => enqueueEmbed('ATTACHMENT', a.id)),
    ...parts.map((p) => enqueueEmbed('PART', p.id)),

    // Search index — note the membership differs from the list above.
    ...notes.map((n) => enqueueSearchIndex('note', n.id, 'upsert')),
    ...services.map((s) => enqueueSearchIndex('service', s.id, 'upsert')),
    ...attachments.map((a) => enqueueSearchIndex('attachment', a.id, 'upsert')),
    ...parts.map((p) => enqueueSearchIndex('part', p.id, 'upsert')),
    ...reminderIds.map((id) => enqueueSearchIndex('reminder', id, 'upsert')),
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
 * Part.name flows into: SERVICE_RECORD (via ServiceRecordTarget.partId),
 * ATTACHMENT (direct partId).
 */
export async function enqueuePartRenameCascade(partId: string): Promise<void> {
  const [services, attachments] = await Promise.all([
    prisma.serviceRecord.findMany({
      where: { targets: { some: { partId } } },
      select: { id: true },
    }),
    prisma.attachment.findMany({ where: { partId }, select: { id: true } }),
  ]);
  await Promise.all([
    ...services.map((s) => enqueueEmbed('SERVICE_RECORD', s.id)),
    ...attachments.map((a) => enqueueEmbed('ATTACHMENT', a.id)),

    // Search index: service documents aggregate every target's name into
    // `targetNames`, and attachment documents denormalize their parent's name
    // into `itemName` — a part-attached file is findable by the part's name,
    // so it goes stale on a rename just like the service record does.
    ...services.map((s) => enqueueSearchIndex('service', s.id, 'upsert')),
    ...attachments.map((a) => enqueueSearchIndex('attachment', a.id, 'upsert')),
  ]);
}

/**
 * System.name flows into: ITEM (direct systemId), SERVICE_RECORD (via
 * ServiceTarget.systemId), WARRANTY (via WarrantyTarget.systemId),
 * PART (via PartLink.systemId).
 */
export async function enqueueSystemRenameCascade(systemId: string): Promise<void> {
  const [items, services, warranties, parts] = await Promise.all([
    prisma.item.findMany({ where: { systemId }, select: { id: true } }),
    prisma.serviceRecord.findMany({
      where: { targets: { some: { systemId } } },
      select: { id: true },
    }),
    prisma.warranty.findMany({
      where: { targets: { some: { systemId } } },
      select: { id: true },
    }),
    prisma.part.findMany({ where: { links: { some: { systemId } } }, select: { id: true } }),
  ]);
  await Promise.all([
    ...items.map((i) => enqueueEmbed('ITEM', i.id)),
    ...services.map((s) => enqueueEmbed('SERVICE_RECORD', s.id)),
    ...warranties.map((w) => enqueueEmbed('WARRANTY', w.id)),
    ...parts.map((p) => enqueueEmbed('PART', p.id)),

    // Search index: a system name reaches ONLY part documents, through
    // `parentNames`. Item documents carry no system name (grep `systemName` in
    // lib/search/document.ts — no hits), and service documents carry their
    // notes rather than their targets' names. So no item re-index here.
    ...parts.map((p) => enqueueSearchIndex('part', p.id, 'upsert')),
  ]);
}
