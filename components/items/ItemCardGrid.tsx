import type { Category, Item } from '@prisma/client';
import Link from 'next/link';

import { CategoryIcon } from '@/components/items/CategoryIcon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import type { CalendarDate } from '@/lib/time/tz';

// Prisma's raw `Item` model type is unbranded -- the CalendarDate brand lives on
// the *client result* type (see lib/prisma-extensions.ts). Re-state it here so a
// component typed off the base model still can't be handed an instant.
type ItemWithRelations = Omit<Item, 'purchaseDate'> & {
  purchaseDate: CalendarDate | null;
  category: Category;
  _count: { warrantyTargets: number; serviceRecordTargets: number; itemNotes: number };
};

export function ItemCardGrid({ items }: { items: ItemWithRelations[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.id} className="flex flex-col">
          <CardHeader>
            <CardTitle>
              <Link href={`/items/${item.id}`} className="hover:underline">
                {item.name}
              </Link>
            </CardTitle>
            <Badge variant="secondary" className="flex w-fit items-center gap-1.5">
              <CategoryIcon name={item.category.icon} className="h-3.5 w-3.5" />
              {item.category.name}
            </Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {item.location && (
              <span className="text-sm text-muted-foreground">{item.location}</span>
            )}
            {item.purchaseDate && (
              <span className="text-xs text-muted-foreground">
                Purchased: {formatCalendarDate(item.purchaseDate)}
              </span>
            )}
          </CardContent>
          <CardFooter className="mt-auto text-xs text-muted-foreground">
            {item._count.warrantyTargets} warranties · {item._count.serviceRecordTargets} service
            records
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
