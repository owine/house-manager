import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChecklistListRow } from '@/lib/checklists/queries';

export function ChecklistCard({ checklist }: { checklist: ChecklistListRow }) {
  const { totalItems, completedItems } = checklist;
  const pct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
  const allDone = totalItems > 0 && completedItems === totalItems;

  return (
    <Link href={`/checklists/${checklist.id}`} className="block">
      <Card className={`transition-shadow hover:shadow-md ${checklist.active ? '' : 'opacity-60'}`}>
        <CardHeader>
          <CardTitle className="flex items-baseline justify-between gap-2">
            <span className="truncate">{checklist.name}</span>
            {!checklist.active && (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                Archived
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {completedItems}/{totalItems} {totalItems === 1 ? 'item' : 'items'} done
            </span>
            {totalItems > 0 && (
              <span className={allDone ? 'font-medium text-green-600 dark:text-green-400' : ''}>
                {pct}%
              </span>
            )}
          </div>
          {totalItems > 0 && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full transition-all ${
                  allDone ? 'bg-green-600 dark:bg-green-400' : 'bg-primary'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
