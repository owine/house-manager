import Link from 'next/link';
import { PART_KIND_LABELS } from '@/components/parts/kind-labels';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { listParts } from '@/lib/parts/queries';

type PartRow = Awaited<ReturnType<typeof listParts>>['parts'][number];

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export function PartTable({ parts }: { parts: PartRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Manufacturer</TableHead>
          <TableHead>Model / SKU</TableHead>
          <TableHead>Linked to</TableHead>
          <TableHead>Typical cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {parts.map((p) => {
          const parents = p.links
            .map((l) => l.item ?? l.system)
            .filter((parent): parent is NonNullable<typeof parent> => parent !== null);
          return (
            <TableRow key={p.id}>
              <TableCell>
                <Link href={`/parts/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                {p.archivedAt && (
                  <Badge variant="destructive" className="ml-2">
                    Archived
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{PART_KIND_LABELS[p.kind]}</Badge>
              </TableCell>
              <TableCell>
                {p.manufacturer ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                {p.model ?? p.sku ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                {parents.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {parents.map((parent) => (
                      <Badge key={parent.id} variant="outline">
                        {parent.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell>
                {p.typicalCost === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  currencyFmt.format(Number(p.typicalCost))
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
