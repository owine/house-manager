import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import type { getPart } from '@/lib/parts/queries';

type Part = NonNullable<Awaited<ReturnType<typeof getPart>>>;

type Props = { part: Part };

export function RemindersTab({ part }: Props) {
  if (part.reminderTargets.length === 0) {
    return <p className="text-sm text-muted-foreground">no reminders or chores yet.</p>;
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <ul className="divide-y">
          {part.reminderTargets.map((target) => (
            <li key={target.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2">
                <Badge variant="secondary">
                  {target.reminder.kind === 'CHORE' ? 'Chore' : 'Reminder'}
                </Badge>
                <Link
                  href={`/reminders/${target.reminder.id}`}
                  className="text-sm underline-offset-4 hover:underline"
                >
                  {target.reminder.title}
                </Link>
                {!target.reminder.active && (
                  <span className="text-xs text-muted-foreground">(inactive)</span>
                )}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatCalendarDate(target.nextDueOn)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
