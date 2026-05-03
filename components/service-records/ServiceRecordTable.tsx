import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// Structural interface matching Prisma's Decimal for display purposes
interface DecimalLike {
  toNumber(): number;
}

type ServiceRecordRow = {
  id: string;
  performedOn: Date;
  summary: string;
  cost: DecimalLike | null;
  item: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
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
          <TableHead>Item</TableHead>
          <TableHead>Vendor</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={record.id}>
            <TableCell>
              <Link href={`/service/${record.id}`} className="underline underline-offset-2">
                {record.performedOn.toISOString().slice(0, 10)}
              </Link>
            </TableCell>
            <TableCell>
              <Link href={`/service/${record.id}`} className="underline underline-offset-2">
                {record.summary}
              </Link>
            </TableCell>
            <TableCell>
              {record.item ? (
                <Link href={`/items/${record.item.id}`} className="underline underline-offset-2">
                  {record.item.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>
              {record.vendor ? (
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
