import Link from 'next/link';
import { TargetsChips } from '@/components/targets/TargetsChips';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ActivityEvent } from '@/lib/dashboard/queries';

function relativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.round(seconds / 86400)}d ago`;
  return date.toISOString().slice(0, 10);
}

type Props = {
  activity: ActivityEvent[];
};

export function RecentActivityList({ activity }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet —{' '}
            <Link href="/items/new" className="underline">
              add an item to get started
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-1">
            {activity.map((event) => {
              const hasTargets = event.targets && event.targets.length > 0;
              return (
                <li
                  key={`${event.kind}-${event.href}`}
                  className="flex items-baseline gap-2 border-b py-2 text-sm last:border-b-0"
                >
                  <span className="shrink-0">{event.icon}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={event.href} className="block truncate">
                      {event.label}
                    </Link>
                    {hasTargets && (
                      <div className="mt-1">
                        <TargetsChips targets={event.targets ?? []} inert />
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {relativeTime(event.occurredAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
