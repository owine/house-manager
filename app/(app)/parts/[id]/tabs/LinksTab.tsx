import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { getPart } from '@/lib/parts/queries';

type Part = NonNullable<Awaited<ReturnType<typeof getPart>>>;

type Props = { part: Part };

export function LinksTab({ part }: Props) {
  if (part.links.length === 0) {
    return <p className="text-sm text-muted-foreground">not linked to any item or system yet.</p>;
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Parent</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Qty installed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {part.links.map((link) => {
              const parent = link.item ?? link.system;
              const href = link.item ? `/items/${link.item.id}` : `/systems/${link.system?.id}`;
              return (
                <TableRow key={link.id}>
                  <TableCell>
                    {parent ? (
                      <Link href={href} className="font-medium underline-offset-2 hover:underline">
                        {parent.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {parent?.archivedAt && (
                      <span className="ml-1 text-muted-foreground">(archived)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{link.item ? 'Item' : 'System'}</Badge>
                  </TableCell>
                  <TableCell>
                    {link.location ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    {link.quantityInstalled ?? <span className="text-muted-foreground">—</span>}
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
