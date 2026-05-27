import { Badge } from '@/components/ui/badge';
import { isOverdue, tzParts } from '@/lib/time/tz';

type Props = {
  nextDueOn: Date;
  active: boolean;
  tz: string;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
};

function calendarDaysBetween(
  later: { year: number; month: number; day: number },
  earlier: { year: number; month: number; day: number },
): number {
  const a = Date.UTC(later.year, later.month - 1, later.day);
  const b = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  return Math.round((a - b) / 86_400_000);
}

export function ReminderStatusBadge({ nextDueOn, active, tz, now = new Date() }: Props) {
  if (!active) {
    return (
      <Badge variant="secondary" data-testid="reminder-due-badge">
        Inactive
      </Badge>
    );
  }
  if (isOverdue(nextDueOn, now, tz)) {
    return (
      <Badge variant="destructive" data-testid="reminder-due-badge">
        Overdue
      </Badge>
    );
  }
  const days = calendarDaysBetween(tzParts(nextDueOn, tz), tzParts(now, tz));
  if (days <= 3) {
    return (
      <Badge
        variant="outline"
        className="text-amber-700 dark:text-amber-400"
        data-testid="reminder-due-badge"
      >
        {days === 0 ? 'Due today' : 'Due soon'}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="reminder-due-badge">
      In {days}d
    </Badge>
  );
}
