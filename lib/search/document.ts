import type { PartKind } from '@prisma/client';

import { PART_KIND_LABELS } from '@/components/parts/kind-labels';
import { prisma } from '@/lib/db';
import { visibleMetadataEntries } from '@/lib/metadata/reserved-keys';
import type { SearchDocument, SearchKind } from './schema';

// ─── Row types — minimal shapes that toDocument needs ───────────────────────
// These match the select clauses used by buildDocument in Task 5; keeping them
// here lets the pure transforms be unit-tested without Prisma.

export type ItemRow = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  notes: string | null;
  category: { slug: string } | null;
  updatedAt: Date;
};

type VendorRow = {
  id: string;
  name: string;
  notes: string | null;
  updatedAt: Date;
};

type NoteRow = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  item: { id: string; name: string } | null;
  updatedAt: Date;
};

type ServiceRow = {
  id: string;
  summary: string;
  notes: string | null;
  /** Primary item-target, used as the `itemId` filter facet anchor. */
  item: { id: string; name: string } | null;
  /**
   * All target names (item + system) concatenated into the searchable
   * `itemName` field so multi-target records are findable by any name.
   * When omitted, falls back to `item?.name` for compatibility.
   */
  targetNames?: string[];
  updatedAt: Date;
};

export type ReminderRow = {
  id: string;
  title: string;
  description: string | null;
  item: { id: string; name: string } | null;
  updatedAt: Date;
};

export type AttachmentRow = {
  id: string;
  filename: string | null; // schema field is String?
  displayLabel: string | null; // fallback for external-URL attachments with no filename
  extractedText: string | null;
  item: { id: string; name: string } | null;
  createdAt: Date; // Attachment has no updatedAt column — use createdAt as the sort key
};

type ChecklistRow = {
  id: string;
  name: string;
  description: string | null;
  items: { title: string }[];
  updatedAt: Date;
};

export type PartRow = {
  id: string;
  name: string;
  kind: PartKind;
  manufacturer: string | null;
  model: string | null;
  sku: string | null;
  location: string | null;
  notes: string | null;
  /** The per-kind spec blob. Reserved keys are dropped by `toDocument`. */
  metadata: unknown;
  /** Names of every linked parent (item + system), for `itemName`. */
  parentNames?: string[];
  /** First *item* parent, supplying the `itemId` filter facet. */
  item: { id: string; name: string } | null;
  updatedAt: Date;
};

export type RowFor<K extends SearchKind> = K extends 'item'
  ? ItemRow
  : K extends 'vendor'
    ? VendorRow
    : K extends 'note'
      ? NoteRow
      : K extends 'service'
        ? ServiceRow
        : K extends 'reminder'
          ? ReminderRow
          : K extends 'attachment'
            ? AttachmentRow
            : K extends 'checklist'
              ? ChecklistRow
              : K extends 'part'
                ? PartRow
                : never;

// ─── Pure transform per kind ────────────────────────────────────────────────

const ICON: Record<SearchKind, string> = {
  item: '📦',
  vendor: '🏢',
  note: '📝',
  service: '🔧',
  reminder: '⏰',
  attachment: '📎',
  checklist: '✅',
  part: '🔩',
};

/**
 * One spec entry rendered as searchable text.
 *
 * The key travels with the value because the queries this PR exists to serve
 * are written that way — "MERV 11", "E26 base" — and a bare `11` matches
 * nothing useful on its own. Arrays are flattened; objects are skipped rather
 * than `[object Object]`-ed into the index.
 */
function specText(key: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v) => specText(key, v));
  if (typeof value === 'object') return [];
  return [key, String(value)];
}

export function toDocument<K extends SearchKind>(kind: K, row: RowFor<K>): SearchDocument {
  switch (kind) {
    case 'item': {
      const r = row as ItemRow;
      const bodyParts = [r.manufacturer, r.model, r.notes].filter(Boolean);
      return {
        id: `item-${r.id}`,
        kind: 'item',
        recordId: r.id,
        title: r.name,
        body: bodyParts.join(' '),
        tags: [],
        itemName: r.name,
        itemId: r.id,
        categorySlug: r.category?.slug ?? null,
        href: `/items/${r.id}`,
        iconHint: ICON.item,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
    case 'vendor': {
      const r = row as VendorRow;
      return {
        id: `vendor-${r.id}`,
        kind: 'vendor',
        recordId: r.id,
        title: r.name,
        body: r.notes ?? '',
        tags: [],
        itemName: '',
        itemId: null,
        categorySlug: null,
        href: `/vendors/${r.id}`,
        iconHint: ICON.vendor,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
    case 'note': {
      const r = row as NoteRow;
      return {
        id: `note-${r.id}`,
        kind: 'note',
        recordId: r.id,
        title: r.title,
        body: r.body,
        tags: r.tags,
        itemName: r.item?.name ?? '',
        itemId: r.item?.id ?? null,
        categorySlug: null,
        href: `/notes/${r.id}`,
        iconHint: ICON.note,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
    case 'service': {
      const r = row as ServiceRow;
      const itemName =
        r.targetNames && r.targetNames.length > 0 ? r.targetNames.join(' ') : (r.item?.name ?? '');
      return {
        id: `service-${r.id}`,
        kind: 'service',
        recordId: r.id,
        title: r.summary,
        body: r.notes ?? '',
        tags: [],
        itemName,
        itemId: r.item?.id ?? null,
        categorySlug: null,
        href: `/service/${r.id}`,
        iconHint: ICON.service,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
    case 'reminder': {
      const r = row as ReminderRow;
      return {
        id: `reminder-${r.id}`,
        kind: 'reminder',
        recordId: r.id,
        title: r.title,
        body: r.description ?? '',
        tags: [],
        itemName: r.item?.name ?? '',
        itemId: r.item?.id ?? null,
        categorySlug: null,
        href: `/reminders/${r.id}`,
        iconHint: ICON.reminder,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
    case 'attachment': {
      const r = row as AttachmentRow;
      // The current app has no /attachments/[id] route. Linking the search
      // hit to the parent item's page is the closest useful target — the
      // Item page's Files tab lists the attachments. If there's no parent
      // item, fall back to /items (better than a guaranteed 404).
      const href = r.item?.id ? `/items/${r.item.id}?tab=files` : '/items';
      return {
        id: `attachment-${r.id}`,
        kind: 'attachment',
        recordId: r.id,
        title: r.filename ?? r.displayLabel ?? '',
        body: r.extractedText ?? '',
        tags: [],
        itemName: r.item?.name ?? '',
        itemId: r.item?.id ?? null,
        categorySlug: null,
        href,
        iconHint: ICON.attachment,
        updatedAt: Math.floor(r.createdAt.getTime() / 1000),
      };
    }
    case 'checklist': {
      const r = row as ChecklistRow;
      return {
        id: `checklist-${r.id}`,
        kind: 'checklist',
        recordId: r.id,
        title: r.name,
        body: [r.description ?? '', ...r.items.map((i) => i.title)].join('\n'),
        tags: [],
        itemName: '',
        itemId: null,
        categorySlug: null,
        href: `/checklists/${r.id}`,
        iconHint: ICON.checklist,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
    case 'part': {
      const r = row as PartRow;
      // Indexing the name alone would be useless: nobody searches "Backyard
      // bulbs", they search "E26" or "20x25x1". The spec values are the
      // point of indexing a part at all — enumerated through
      // `visibleMetadataEntries` so `_provenance` (written by conversational
      // capture) can never reach the index.
      const spec = visibleMetadataEntries(r.metadata).flatMap(([k, v]) => specText(k, v));
      const bodyParts = [
        PART_KIND_LABELS[r.kind],
        r.manufacturer,
        r.model,
        r.sku,
        r.location,
        ...spec,
        r.notes,
      ].filter(Boolean);
      return {
        id: `part-${r.id}`,
        kind: 'part',
        recordId: r.id,
        title: r.name,
        body: bodyParts.join(' '),
        tags: [],
        // Parent names make "furnace filter" find a part actually named
        // "FPR 10 20x25x1".
        itemName: (r.parentNames ?? []).join(' ') || (r.item?.name ?? ''),
        itemId: r.item?.id ?? null,
        categorySlug: null,
        href: `/parts/${r.id}`,
        iconHint: ICON.part,
        updatedAt: Math.floor(r.updatedAt.getTime() / 1000),
      };
    }
  }
}

/**
 * Fetches the row for (kind, id) and runs toDocument. Returns null if the
 * row no longer exists — caller treats null as "delete from index".
 */
export async function buildDocument(kind: SearchKind, id: string): Promise<SearchDocument | null> {
  switch (kind) {
    case 'item': {
      const row = await prisma.item.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          manufacturer: true,
          model: true,
          notes: true,
          updatedAt: true,
          category: { select: { slug: true } },
        },
      });
      return row ? toDocument('item', row) : null;
    }
    case 'vendor': {
      const row = await prisma.vendor.findUnique({
        where: { id },
        select: { id: true, name: true, notes: true, updatedAt: true },
      });
      return row ? toDocument('vendor', row) : null;
    }
    case 'note': {
      const row = await prisma.note.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          body: true,
          tags: true,
          updatedAt: true,
          item: { select: { id: true, name: true } },
        },
      });
      return row ? toDocument('note', row) : null;
    }
    case 'service': {
      const row = await prisma.serviceRecord.findUnique({
        where: { id },
        select: {
          id: true,
          summary: true,
          notes: true,
          updatedAt: true,
          targets: {
            select: {
              item: { select: { id: true, name: true } },
              system: { select: { id: true, name: true } },
              part: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!row) return null;
      // Aggregate every target's name into `itemName` so multi-target records
      // are findable by any of them. The first item-target supplies the
      // `itemId` filter facet (preserves item-scoped search filtering).
      const names: string[] = [];
      let firstItem: { id: string; name: string } | null = null;
      for (const t of row.targets) {
        if (t.item) {
          if (!firstItem) firstItem = t.item;
          names.push(t.item.name);
        }
        if (t.system) names.push(t.system.name);
        // A part target contributes only a name — `itemId` stays the first
        // *item* target's, since the facet filters item-scoped search.
        if (t.part) names.push(t.part.name);
      }
      const { targets: _targets, ...rest } = row;
      return toDocument('service', {
        ...rest,
        item: firstItem,
        targetNames: names,
      });
    }
    case 'reminder': {
      const row = await prisma.reminder.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          description: true,
          updatedAt: true,
          targets: {
            select: { item: { select: { id: true, name: true } } },
          },
        },
      });
      if (!row) return null;
      const item = row.targets.find((t) => t.item !== null)?.item ?? null;
      const { targets: _targets, ...rest } = row;
      return toDocument('reminder', { ...rest, item });
    }
    case 'attachment': {
      const row = await prisma.attachment.findUnique({
        where: { id },
        select: {
          id: true,
          filename: true,
          displayLabel: true,
          extractedText: true,
          createdAt: true, // Attachment has no updatedAt — use createdAt
          item: { select: { id: true, name: true } },
        },
      });
      return row ? toDocument('attachment', row) : null;
    }
    case 'checklist': {
      const row = await prisma.checklist.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          description: true,
          updatedAt: true,
          items: { select: { title: true } },
        },
      });
      return row ? toDocument('checklist', row) : null;
    }
    case 'part': {
      const row = await prisma.part.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          kind: true,
          manufacturer: true,
          model: true,
          sku: true,
          location: true,
          notes: true,
          metadata: true,
          updatedAt: true,
          links: {
            select: {
              item: { select: { id: true, name: true } },
              system: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!row) return null;
      const names: string[] = [];
      let firstItem: { id: string; name: string } | null = null;
      for (const l of row.links) {
        if (l.item) {
          if (!firstItem) firstItem = l.item;
          names.push(l.item.name);
        }
        if (l.system) names.push(l.system.name);
      }
      const { links: _links, ...rest } = row;
      return toDocument('part', { ...rest, item: firstItem, parentNames: names });
    }
  }
}

/**
 * For Item rename or delete: returns the synthetic doc identifiers of every
 * child that denormalizes this item's name (notes, services, reminders,
 * attachments). The handler re-upserts or deletes each.
 */
export async function listChildIdsForItem(
  itemId: string,
): Promise<{ kind: SearchKind; id: string }[]> {
  const [notes, services, reminders, attachments] = await Promise.all([
    prisma.note.findMany({ where: { itemId }, select: { id: true } }),
    prisma.serviceRecord.findMany({
      where: { targets: { some: { itemId } } },
      select: { id: true },
    }),
    prisma.reminder.findMany({
      where: { targets: { some: { itemId } } },
      select: { id: true },
    }),
    prisma.attachment.findMany({ where: { itemId }, select: { id: true } }),
  ]);
  return [
    ...notes.map((n) => ({ kind: 'note' as const, id: n.id })),
    ...services.map((s) => ({ kind: 'service' as const, id: s.id })),
    ...reminders.map((r) => ({ kind: 'reminder' as const, id: r.id })),
    ...attachments.map((a) => ({ kind: 'attachment' as const, id: a.id })),
  ];
}
