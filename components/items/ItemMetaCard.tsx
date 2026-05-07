import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type MetaRowProps = { label: string; value: string };

function MetaRow({ label, value }: MetaRowProps) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

type Props = { item: Item };

export function ItemMetaCard({ item }: Props) {
  const rows: { label: string; value: string }[] = [];

  if (item.location) rows.push({ label: 'Location', value: item.location });
  if (item.manufacturer) rows.push({ label: 'Manufacturer', value: item.manufacturer });
  if (item.model) rows.push({ label: 'Model', value: item.model });
  if (item.serialNumber) rows.push({ label: 'Serial', value: item.serialNumber });
  if (item.purchaseDate)
    rows.push({ label: 'Purchased', value: formatCalendarDate(item.purchaseDate) });
  if (item.purchasePrice !== null && item.purchasePrice !== undefined)
    rows.push({ label: 'Price', value: currencyFmt.format(Number(item.purchasePrice)) });

  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No details recorded.</p>
        ) : (
          <dl className="flex flex-col gap-3">
            {rows.map(({ label, value }) => (
              <MetaRow key={label} label={label} value={value} />
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
