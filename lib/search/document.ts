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

export type VendorRow = {
  id: string;
  name: string;
  notes: string | null;
  updatedAt: Date;
};

export type NoteRow = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  item: { id: string; name: string } | null;
  updatedAt: Date;
};

export type ServiceRow = {
  id: string;
  summary: string;
  notes: string | null;
  item: { id: string; name: string } | null;
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
            : never;

// ─── Pure transform per kind ────────────────────────────────────────────────

const ICON: Record<SearchKind, string> = {
  item: '📦',
  vendor: '🏢',
  note: '📝',
  service: '🔧',
  reminder: '⏰',
  attachment: '📎',
};

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
      return {
        id: `service-${r.id}`,
        kind: 'service',
        recordId: r.id,
        title: r.summary,
        body: r.notes ?? '',
        tags: [],
        itemName: r.item?.name ?? '',
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
  }
}
