import Link from 'next/link';
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
            {activity.map((event) => (
              <li
                key={`${event.kind}-${event.href}`}
                className="flex items-baseline gap-2 border-b py-2 text-sm last:border-b-0"
              >
                <span className="shrink-0">{event.icon}</span>
                <Link href={event.href} className="min-w-0 flex-1 truncate">
                  {event.label}
                </Link>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                  {relativeTime(event.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
