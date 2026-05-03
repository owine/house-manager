import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReminderStatusBadge } from './ReminderStatusBadge';

type Row = {
  id: string;
  title: string;
  nextDueOn: Date;
  active: boolean;
  item: { id: string; name: string } | null;
};

export function ReminderTable({ reminders }: { reminders: Row[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Item</TableHead>
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
              {r.item ? (
                <Link href={`/items/${r.item.id}`} className="underline underline-offset-2">
                  {r.item.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>{r.nextDueOn.toISOString().slice(0, 10)}</TableCell>
            <TableCell>
              <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
