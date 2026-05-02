import Link from 'next/link';
import { cn } from '@/lib/utils';

export type TabSlug = 'overview' | 'warranties' | 'service' | 'notes' | 'files' | 'reminders';

const TABS: { slug: TabSlug; label: string }[] = [
  { slug: 'overview', label: 'Overview' },
  { slug: 'warranties', label: 'Warranties' },
  { slug: 'service', label: 'Service' },
  { slug: 'notes', label: 'Notes' },
  { slug: 'files', label: 'Files' },
  { slug: 'reminders', label: 'Reminders' },
];

type Props = {
  active: TabSlug;
  itemId: string;
};

export function ItemTabs({ active, itemId }: Props) {
  return (
    <nav className="-mb-px flex gap-1 border-b">
      {TABS.map(({ slug, label }) => (
        <Link
          key={slug}
          href={`/items/${itemId}?tab=${slug}`}
          className={cn(
            'inline-flex h-9 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground transition-colors hover:text-foreground',
            slug === active && 'border-foreground font-medium text-foreground',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
