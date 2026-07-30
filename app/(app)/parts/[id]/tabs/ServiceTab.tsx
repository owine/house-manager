import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCalendarDate } from '@/lib/format/date';
import type { getPart } from '@/lib/parts/queries';

type Part = NonNullable<Awaited<ReturnType<typeof getPart>>>;

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type Props = { part: Part };

export function ServiceTab({ part }: Props) {
  if (part.serviceRecordTargets.length === 0) {
    return <p className="text-sm text-muted-foreground">no service records yet.</p>;
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Performed</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {part.serviceRecordTargets.map((target) => {
              const sr = target.serviceRecord;
              return (
                <TableRow key={target.id}>
                  <TableCell>
                    <Link
                      href={`/service/${sr.id}`}
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      {formatCalendarDate(sr.performedOn)}
                    </Link>
                  </TableCell>
                  <TableCell>{sr.summary}</TableCell>
                  <TableCell>
                    {sr.vendor ? (
                      <Link
                        href={`/vendors/${sr.vendor.id}`}
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {sr.vendor.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {sr.cost ? (
                      currencyFmt.format(sr.cost.toNumber())
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
