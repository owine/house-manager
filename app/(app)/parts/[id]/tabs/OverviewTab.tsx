import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Markdown } from '@/lib/markdown';
import { visibleMetadataEntries } from '@/lib/metadata/reserved-keys';
import type { getPart } from '@/lib/parts/queries';

type Part = NonNullable<Awaited<ReturnType<typeof getPart>>>;

/**
 * Convert a camelCase key to a human-readable label.
 * All-lowercase keys of 2–4 chars (merv, mpr, fpr, cri) are uppercased whole.
 */
function toLabel(key: string): string {
  if (/^[a-z]{2,4}$/.test(key)) return key.toUpperCase();
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function stringifySpecValue(value: unknown): string {
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

type PurchaseLink = { label?: string; url: string };

function purchaseLinksOf(value: unknown): PurchaseLink[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is PurchaseLink =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { url?: unknown }).url === 'string',
  );
}

type Props = { part: Part };

export function OverviewTab({ part }: Props) {
  // Reserved keys (`_provenance` et al) are internal bookkeeping — see
  // lib/metadata/reserved-keys.ts. The read path has to drop them or an
  // AI-captured part renders a raw JSON blob in its Spec card.
  const visibleSpec = visibleMetadataEntries(part.metadata);
  const links = purchaseLinksOf(part.purchaseLinks);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="pt-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
            {part.location && (
              <>
                <dt className="font-medium">Location</dt>
                <dd>{part.location}</dd>
              </>
            )}
            {part.manufacturer && (
              <>
                <dt className="font-medium">Manufacturer</dt>
                <dd>{part.manufacturer}</dd>
              </>
            )}
            {part.model && (
              <>
                <dt className="font-medium">Model</dt>
                <dd>{part.model}</dd>
              </>
            )}
            {part.sku && (
              <>
                <dt className="font-medium">SKU</dt>
                <dd>{part.sku}</dd>
              </>
            )}
            {part.typicalCost !== null && part.typicalCost !== undefined && (
              <>
                <dt className="font-medium">Typical cost</dt>
                <dd>{currencyFmt.format(Number(part.typicalCost))}</dd>
              </>
            )}
            {part.packQuantity !== null && part.packQuantity !== undefined && (
              <>
                <dt className="font-medium">Pack quantity</dt>
                <dd>{part.packQuantity}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {visibleSpec.length > 0 && (
        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Spec</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
              {visibleSpec.map(([key, value]) => {
                const displayValue = stringifySpecValue(value);
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

      {links.length > 0 && (
        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Where to buy</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <ul className="space-y-1">
              {links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm underline underline-offset-2"
                  >
                    {link.label || link.url}
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {part.notes && (
        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm pt-4">
            <Markdown>{part.notes}</Markdown>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
