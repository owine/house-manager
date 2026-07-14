import { Badge } from '@/components/ui/badge';
import { type CalendarDate, isOverdue, startOfDayUtc } from '@/lib/time/tz';

type Props = {
  nextDueOn: CalendarDate;
  active: boolean;
  tz: string;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
};

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
  // `nextDueOn` is a calendar date (UTC midnight) -- it is already a day, so it
  // must be read in UTC. Only `now`, a real instant, needs the house timezone,
  // to work out which day "today" is. Running the due date through the tz (as
  // this once did) drags it onto the previous day in any negative-offset zone.
  const days = Math.round((nextDueOn.getTime() - startOfDayUtc(now, tz).getTime()) / 86_400_000);
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
