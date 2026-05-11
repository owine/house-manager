import Link from 'next/link';
import type { AskCitation } from '@/lib/ai/schemas';

// Map an embedding entity type to the canonical detail route. Attachments
// don't have their own page — they live under a parent (item, service
// record, etc.) — so when this component runs into one it falls back to
// a non-link chip until the route is resolvable. The full deep-link
// behaviour for attachments arrives later when retrieval gives us the
// attachment's parent context.
function hrefFor(c: AskCitation): string | null {
  switch (c.entityType) {
    case 'ITEM':
      return `/items/${c.entityId}`;
    case 'NOTE':
      return `/notes/${c.entityId}`;
    case 'SERVICE_RECORD':
      return `/service/${c.entityId}`;
    case 'WARRANTY':
      return `/warranties/${c.entityId}`;
    case 'CHECKLIST_ITEM':
      return `/checklists/${c.entityId}`;
    case 'ATTACHMENT':
      return null;
    default:
      return null;
  }
}

function labelPrefix(c: AskCitation): string {
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

export function CitationChip({ citation }: { citation: AskCitation }) {
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
