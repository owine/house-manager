import { Badge } from '@/components/ui/badge';
import { formatCalendarDate } from '@/lib/format/date';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';

export interface CompletionRowProps {
  id: string;
  completedOn: Date;
  completedById: string;
  completedBy: { name: string | null };
  notes: string | null;
}

export function CompletionRow({
  completedOn,
  completedById,
  completedBy,
  notes,
}: CompletionRowProps) {
  const isAuto = completedById === SYSTEM_AUTO_COMPLETE_USER_ID;
  return (
    <>
      {formatCalendarDate(completedOn)} — completed by {completedBy.name}
      {isAuto && (
        <Badge variant="outline" className="ml-1 text-xs">
          Auto
        </Badge>
      )}
      {notes && <span className="text-muted-foreground">: {notes}</span>}
    </>
  );
}
