import Link from 'next/link';
import type { EnrichedAskCitation } from '@/lib/ask/actions';

// Map an embedding entity type to the canonical detail route. ATTACHMENT
// citations are enriched server-side with parent FK info, so they deep-link
// to the parent entity with `?attachment=<id>` — the AttachmentScrollHighlight
// component on the parent page then scrolls + pulses the row.
function hrefFor(c: EnrichedAskCitation): string | null {
  if (c.entityType === 'ATTACHMENT' && c.parent) {
    const base = parentRoute(c.parent.entityType, c.parent.entityId);
    return base ? `${base}?attachment=${c.entityId}` : null;
  }
  return parentRoute(
    c.entityType as 'ITEM' | 'NOTE' | 'SERVICE_RECORD' | 'WARRANTY' | 'CHECKLIST_ITEM',
    c.entityId,
  );
}

function parentRoute(
  kind: 'ITEM' | 'NOTE' | 'SERVICE_RECORD' | 'WARRANTY' | 'CHECKLIST_ITEM',
  id: string,
): string | null {
  switch (kind) {
    case 'ITEM':
      return `/items/${id}`;
    case 'NOTE':
      return `/notes/${id}`;
    case 'SERVICE_RECORD':
      return `/service/${id}`;
    case 'WARRANTY':
      return `/warranties/${id}`;
    case 'CHECKLIST_ITEM':
      return `/checklists/${id}`;
    default:
      return null;
  }
}

function labelPrefix(c: EnrichedAskCitation): string {
  switch (c.entityType) {
    case 'ITEM':
      return 'Item';
    case 'NOTE':
      return 'Note';
    case 'SERVICE_RECORD':
      return 'Service';
    case 'WARRANTY':
      return 'Warranty';
    case 'CHECKLIST_ITEM':
      return 'Checklist';
    case 'ATTACHMENT':
      return 'Attachment';
    default:
      return 'Source';
  }
}

export function CitationChip({ citation }: { citation: EnrichedAskCitation }) {
  const href = hrefFor(citation);
  const text = `${labelPrefix(citation)}: ${citation.label}`;
  const className =
    'inline-flex max-w-full items-center gap-1 truncate rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground';

  if (!href) {
    return (
      <span className={className} title={text}>
        {text}
      </span>
    );
  }

  return (
    <Link className={className} href={href} title={text}>
      {text}
    </Link>
  );
}
