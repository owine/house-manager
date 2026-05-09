import Link from 'next/link';
import { type TargetSummary, TargetsChips } from '@/components/targets/TargetsChips';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCalendarDate } from '@/lib/format/date';
import { ReminderStatusBadge } from './ReminderStatusBadge';

type Row = {
  id: string;
  title: string;
  nextDueOn: Date | null;
  active: boolean;
  /**
   * Multi-target chip set. The chip renderer dedupes item chips whose
   * parent system is also in the same target set; this matches the
   * behavior shipped on /service in PR #85.
   */
  targets: TargetSummary[];
};

export function ReminderTable({ reminders }: { reminders: Row[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Targets</TableHead>
          <TableHead>Next due</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reminders.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link href={`/reminders/${r.id}`} className="underline underline-offset-2">
                {r.title}
              </Link>
            </TableCell>
            <TableCell>
              <TargetsChips targets={r.targets} />
            </TableCell>
            <TableCell>{r.nextDueOn ? formatCalendarDate(r.nextDueOn) : '—'}</TableCell>
            <TableCell>
              {r.nextDueOn ? (
                <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
