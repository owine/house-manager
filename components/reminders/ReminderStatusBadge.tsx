import { Badge } from '@/components/ui/badge';

const DAY_MS = 86_400_000;

type Props = { nextDueOn: Date; active: boolean };

export function ReminderStatusBadge({ nextDueOn, active }: Props) {
  if (!active) {
    return (
      <Badge variant="secondary" data-testid="reminder-due-badge">
        Inactive
      </Badge>
    );
  }
  const days = Math.floor((nextDueOn.getTime() - Date.now()) / DAY_MS);
  if (days < 0) {
    return (
      <Badge variant="destructive" data-testid="reminder-due-badge">
        Overdue
      </Badge>
    );
  }
  if (days <= 3) {
    return (
      <Badge
        variant="outline"
        className="text-amber-700 dark:text-amber-400"
        data-testid="reminder-due-badge"
      >
        Due soon
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="reminder-due-badge">
      In {days}d
    </Badge>
  );
}
