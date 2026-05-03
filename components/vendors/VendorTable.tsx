import type { Vendor } from '@prisma/client';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type VendorWithCount = Vendor & { _count: { serviceRecords: number } };

export function VendorTable({ vendors }: { vendors: VendorWithCount[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>Tags</TableHead>
          <TableHead>Service records</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {vendors.map((v) => (
          <TableRow key={v.id}>
            <TableCell>
              <Link href={`/vendors/${v.id}`} className="font-medium hover:underline">
                {v.name}
              </Link>
            </TableCell>
            <TableCell>
              {v.kind ? (
                <Badge variant="secondary">{v.kind}</Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>{v.phone ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {v.tags.map((t) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </div>
            </TableCell>
            <TableCell>{v._count.serviceRecords}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
