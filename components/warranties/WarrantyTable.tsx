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
  /**
   * Multi-target chip set. On an item-detail page this surfaces "what else
   * does this warranty cover" — the current item is implied by context, the
   * chips show every other item / system on the same policy.
   */
  targets: TargetSummary[];
};

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export function WarrantyTable({ warranties, tz }: { warranties: WarrantyRow[]; tz: string }) {
  if (warranties.length === 0) {
    return <p className="text-sm text-muted-foreground">no warranties recorded.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Policy #</TableHead>
          <TableHead>Coverage</TableHead>
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
            <TableCell>
              <TargetsChips targets={warranty.targets} />
            </TableCell>
            <TableCell>{formatCalendarDate(warranty.startsOn)}</TableCell>
            <TableCell>{formatCalendarDate(warranty.endsOn)}</TableCell>
            <TableCell>
              <WarrantyStatusBadge endsOn={warranty.endsOn} tz={tz} />
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
