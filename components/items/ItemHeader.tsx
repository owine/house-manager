import Link from 'next/link';
import type { ReactNode } from 'react';
import { CategoryIcon } from '@/components/items/CategoryIcon';
import { Badge } from '@/components/ui/badge';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

type Props = {
  item: Item;
  actions?: ReactNode;
};

export function ItemHeader({ item, actions }: Props) {
  const isArchived = item.archivedAt !== null;

  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{item.name}</h1>
          <Badge variant="secondary" className="flex items-center gap-1.5">
            <CategoryIcon name={item.category.icon} className="h-3.5 w-3.5" />
            {item.category.name}
          </Badge>
          {isArchived && (
            <Badge variant="destructive">
              Archived {item.archivedAt?.toISOString().slice(0, 10)}
            </Badge>
          )}
        </div>
        {item.system ? (
          <div className="text-sm text-muted-foreground" data-testid="item-header-system">
            System:{' '}
            <Link
              href={`/systems/${item.system.id}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {item.system.name}
            </Link>
            {item.system.archivedAt ? <span className="ml-1">(archived)</span> : null}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground" data-testid="item-header-system-empty">
            <Link href={`/items/${item.id}/edit`} className="underline-offset-2 hover:underline">
              Assign to system
            </Link>
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
