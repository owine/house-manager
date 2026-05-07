import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCalendarDate } from '@/lib/format/date';
import { WarrantyRowActions } from './WarrantyRowActions';
import { WarrantyStatusBadge } from './WarrantyStatusBadge';

// Structural interface matching Prisma's Decimal for display purposes
interface DecimalLike {
  toNumber(): number;
}

type WarrantyRow = {
  id: string;
  provider: string;
  policyNumber: string | null;
  startsOn: Date;
  endsOn: Date;
  cost: DecimalLike | null;
};

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export function WarrantyTable({ warranties }: { warranties: WarrantyRow[] }) {
  if (warranties.length === 0) {
    return <p className="text-sm text-muted-foreground">No warranties recorded.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Policy #</TableHead>
          <TableHead>Starts on</TableHead>
          <TableHead>Ends on</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {warranties.map((warranty) => (
          <TableRow key={warranty.id}>
            <TableCell>
              <Link href={`/warranties/${warranty.id}`} className="underline underline-offset-2">
                {warranty.provider}
              </Link>
            </TableCell>
            <TableCell>{warranty.policyNumber ?? '—'}</TableCell>
            <TableCell>{formatCalendarDate(warranty.startsOn)}</TableCell>
            <TableCell>{formatCalendarDate(warranty.endsOn)}</TableCell>
            <TableCell>
              <WarrantyStatusBadge endsOn={warranty.endsOn} />
            </TableCell>
            <TableCell className="text-right">
              {warranty.cost != null ? currencyFmt.format(warranty.cost.toNumber()) : '—'}
            </TableCell>
            <TableCell>
              <WarrantyRowActions warrantyId={warranty.id} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
