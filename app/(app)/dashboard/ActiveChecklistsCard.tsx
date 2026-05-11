import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChecklistListRow } from '@/lib/checklists/queries';

type Props = {
  checklists: ChecklistListRow[];
};

/**
 * Dashboard widget showing active checklists with at least one pending
 * item. Sorted (by `listChecklists`) so the most-incomplete ones land
 * first. Each row is a compact link with a slim progress bar.
 *
 * Hidden entirely when there's nothing actionable — the dashboard already
 * has enough "nothing to do here" placeholders.
 */
export function ActiveChecklistsCard({ checklists }: Props) {
  const pending = checklists.filter(
    (c) => c.active && c.totalItems > 0 && c.completedItems < c.totalItems,
  );
  if (pending.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Checklists in progress</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {pending.map((c) => {
            const pct = Math.round((c.completedItems / c.totalItems) * 100);
            return (
              <li key={c.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  href={`/checklists/${c.id}`}
                  className="block space-y-1.5 rounded-md p-1 hover:bg-muted/50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.name}</span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                      {c.completedItems}/{c.totalItems}
                    </span>
                  </div>
                  <div
                    className="h-1 w-full overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
