import { Badge } from '@/components/ui/badge';
import { formatHouseDay } from '@/lib/format/date';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';

export interface CompletionRowProps {
  completedOn: Date;
  completedById: string;
  completedBy: { name: string | null };
  notes: string | null;
  tz: string;
}

export function CompletionRow({
  completedOn,
  completedById,
  completedBy,
  notes,
  tz,
}: CompletionRowProps) {
  const isAuto = completedById === SYSTEM_AUTO_COMPLETE_USER_ID;
  return (
    <>
      {/* `completedOn` is an INSTANT, not a calendar date. Rendering it with
          formatCalendarDate showed its UTC day, so an evening completion read a
          day late -- and auto-completed chores, stamped at 04:59:59Z the next UTC
          day, read a day late every single time. */}
      {formatHouseDay(completedOn, tz)} — completed by {completedBy.name}
      {isAuto && (
        <Badge variant="outline" className="ml-1 text-xs">
          Auto
        </Badge>
      )}
      {notes && <span className="text-muted-foreground">: {notes}</span>}
    </>
  );
}
