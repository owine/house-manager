import { Badge } from '@/components/ui/badge';
import { isOverdue, startOfDayUtc } from '@/lib/time/tz';

type Props = {
  endsOn: Date;
  tz: string;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
};

export function WarrantyStatusBadge({ endsOn, tz, now = new Date() }: Props) {
  // `endsOn` is a calendar date (UTC midnight) and coverage is inclusive of that
  // day, so the warranty expires when the house day moves PAST it -- which is
  // exactly `isOverdue`. Subtracting `Date.now()` from it (as this once did)
  // went negative at UTC midnight, i.e. 7pm Chicago the evening before.
  if (isOverdue(endsOn, now, tz)) {
    return <Badge variant="destructive">Expired</Badge>;
  }
  const days = Math.round((endsOn.getTime() - startOfDayUtc(now, tz).getTime()) / 86_400_000);
  if (days < 60) {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
        Expiring soon
      </Badge>
    );
  }
  return <Badge variant="secondary">Active</Badge>;
}
