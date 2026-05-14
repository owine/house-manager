import type { LucideIcon } from 'lucide-react';
import { Calendar, CheckSquare, Package, Paperclip, StickyNote, Users, Wrench } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { HL_CLOSE, HL_OPEN } from '@/lib/search/highlight';
import type { SearchHit } from '@/lib/search/queries';
import type { SearchKind } from '@/lib/search/schema';

type Props = {
  hits: SearchHit[];
  variant?: 'dropdown' | 'page';
  onItemClick?: () => void;
};

const KIND_ICONS: Record<SearchKind, LucideIcon> = {
  item: Package,
  vendor: Users,
  note: StickyNote,
  service: Wrench,
  reminder: Calendar,
  attachment: Paperclip,
  checklist: CheckSquare,
};

const KIND_LABELS: Record<SearchKind, string> = {
  item: 'Item',
  vendor: 'Vendor',
  note: 'Note',
  service: 'Service',
  reminder: 'Reminder',
  attachment: 'Attachment',
  checklist: 'Checklist',
};

// Splits a Meilisearch _formatted string on HL_OPEN/HL_CLOSE sentinels and
// returns alternating plain text + <em>-wrapped highlight nodes. Text segments
// are rendered through React, so the framework HTML-escapes them; sentinels
// never reach the DOM as raw HTML.
function renderHighlighted(formatted: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const parts = formatted.split(HL_OPEN);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      nodes.push(part);
      continue;
    }
    const closeIdx = part.indexOf(HL_CLOSE);
    if (closeIdx === -1) {
      nodes.push(part);
      continue;
    }
    nodes.push(<em key={i}>{part.slice(0, closeIdx)}</em>);
    nodes.push(part.slice(closeIdx + HL_CLOSE.length));
  }
  return nodes;
}

export function SearchResults({ hits, variant = 'page', onItemClick }: Props) {
  if (hits.length === 0) {
    return <p className="text-sm text-muted-foreground">no results.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {hits.map((hit) => {
        const Icon = KIND_ICONS[hit.kind];
        const liClass = variant === 'dropdown' ? 'px-3 py-2' : 'py-3';
        return (
          <li key={hit.id} className={liClass}>
            <Link
              href={hit.href}
              onClick={onItemClick}
              className="group flex items-start gap-3 no-underline"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <span className="font-medium">
                  {renderHighlighted(hit._formatted?.title ?? hit.title)}
                </span>
                {variant === 'page' && hit._formatted?.body && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {renderHighlighted(hit._formatted.body.slice(0, 200))}
                  </p>
                )}
              </div>
              <Badge variant="outline" className="mt-0.5 shrink-0">
                {KIND_LABELS[hit.kind]}
              </Badge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
