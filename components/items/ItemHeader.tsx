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
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
