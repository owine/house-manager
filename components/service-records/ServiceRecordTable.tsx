import Link from 'next/link';
import { type TargetSummary, TargetsChips } from '@/components/targets/TargetsChips';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCalendarDate } from '@/lib/format/date';

// Structural interface matching Prisma's Decimal for display purposes
interface DecimalLike {
  toNumber(): number;
}

type ServiceRecordRow = {
  id: string;
  performedOn: Date;
  summary: string;
  cost: DecimalLike | null;
  /**
   * Multi-target: each record owns N targets (item or system). The chip
   * renderer dedupes item chips whose parent system is also in the same
   * target set, so a system + its components renders as a single system
   * chip rather than the system plus N redundant item chips.
   */
  targets: TargetSummary[];
  vendor: { id: string; name: string } | null;
  selfPerformed: boolean;
};

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export function ServiceRecordTable({ records }: { records: ServiceRecordRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>Targets</TableHead>
          <TableHead>Vendor</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={record.id}>
            <TableCell>
              <Link href={`/service/${record.id}`} className="underline underline-offset-2">
                {formatCalendarDate(record.performedOn)}
              </Link>
            </TableCell>
            <TableCell>
              <Link href={`/service/${record.id}`} className="underline underline-offset-2">
                {record.summary}
              </Link>
            </TableCell>
            <TableCell>
              <TargetsChips targets={record.targets} />
            </TableCell>
            <TableCell>
              {record.selfPerformed ? (
                <Badge variant="secondary">Self-performed</Badge>
              ) : record.vendor ? (
                <Link
                  href={`/vendors/${record.vendor.id}`}
                  className="underline underline-offset-2"
                >
                  {record.vendor.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              {record.cost != null ? currencyFmt.format(record.cost.toNumber()) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
