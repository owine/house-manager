import Link from 'next/link';
import { cn } from '@/lib/utils';

export type TabSlug = 'overview' | 'warranties' | 'service' | 'notes' | 'files' | 'reminders';

const TABS: { slug: TabSlug; label: string }[] = [
  { slug: 'overview', label: 'overview' },
  { slug: 'warranties', label: 'warranties' },
  { slug: 'service', label: 'service' },
  { slug: 'notes', label: 'notes' },
  { slug: 'files', label: 'files' },
  { slug: 'reminders', label: 'reminders' },
];

type Props = {
  active: TabSlug;
  itemId: string;
};

export function ItemTabs({ active, itemId }: Props) {
  return (
    <nav aria-label="Item tabs" className="-mb-px flex gap-1 overflow-x-auto border-b">
      {TABS.map(({ slug, label }) => (
        <Link
          key={slug}
          href={`/items/${itemId}?tab=${slug}`}
          className={cn(
            'inline-flex h-9 shrink-0 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground transition-colors hover:text-foreground',
            slug === active && 'border-foreground font-medium text-foreground',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
