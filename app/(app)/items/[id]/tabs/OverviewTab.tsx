import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import type { getItem } from '@/lib/items/queries';
import { Markdown } from '@/lib/markdown';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

/**
 * Convert a camelCase key to a human-readable label.
 * All-lowercase keys of 2–4 chars (btu, vin, seer) are uppercased entirely.
 */
function toLabel(key: string): string {
  if (/^[a-z]{2,4}$/.test(key)) return key.toUpperCase();
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function stringifyMetaValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type Props = { item: Item };

export function OverviewTab({ item }: Props) {
  const hasMetadata =
    item.metadata && typeof item.metadata === 'object' && Object.keys(item.metadata).length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Core fields */}
      <Card>
        <CardContent className="pt-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
            {item.location && (
              <>
                <dt className="font-medium">Location</dt>
                <dd>{item.location}</dd>
              </>
            )}
            {item.manufacturer && (
              <>
                <dt className="font-medium">Manufacturer</dt>
                <dd>{item.manufacturer}</dd>
              </>
            )}
            {item.model && (
              <>
                <dt className="font-medium">Model</dt>
                <dd>{item.model}</dd>
              </>
            )}
            {item.serialNumber && (
              <>
                <dt className="font-medium">Serial number</dt>
                <dd>{item.serialNumber}</dd>
              </>
            )}
            {item.purchaseDate && (
              <>
                <dt className="font-medium">Purchase date</dt>
                <dd>{formatCalendarDate(item.purchaseDate)}</dd>
              </>
            )}
            {item.purchasePrice !== null && item.purchasePrice !== undefined && (
              <>
                <dt className="font-medium">Purchase price</dt>
                <dd>{currencyFmt.format(Number(item.purchasePrice))}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Dynamic metadata */}
      {hasMetadata && (
        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Additional Details</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
              {Object.entries(item.metadata as Record<string, unknown>).map(([key, value]) => {
                const displayValue = stringifyMetaValue(value);
                if (!displayValue) return null;
                return (
                  <>
                    <dt key={`${key}-dt`} className="font-medium">
                      {toLabel(key)}
                    </dt>
                    <dd key={`${key}-dd`}>{displayValue}</dd>
                  </>
                );
              })}
            </dl>
          </CardContent>
        </Card>
      )}

      {/* Freeform notes */}
      {item.notes && (
        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm pt-4">
            <Markdown>{item.notes}</Markdown>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
