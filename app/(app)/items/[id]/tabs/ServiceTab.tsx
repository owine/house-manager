import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCalendarDate } from '@/lib/format/date';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type Props = { item: Item };

export function ServiceTab({ item }: Props) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b pb-3">
        <CardTitle>Service history</CardTitle>
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/service/new?itemId=${item.id}`} />}
        >
          + Log service
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        {item.serviceRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground">no service records yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.serviceRecords.map((sr) => (
                <TableRow key={sr.id}>
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
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{sr.cost ? currencyFmt.format(sr.cost.toNumber()) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
