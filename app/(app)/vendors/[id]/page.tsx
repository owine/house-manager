import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DetailPageShell } from '@/app/(app)/_components/DetailPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
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
import { VendorMetaCard } from '@/components/vendors/VendorMetaCard';
import { VendorOverflowMenu } from '@/components/vendors/VendorOverflowMenu';
import { Markdown } from '@/lib/markdown';
import { getVendor } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export default async function VendorDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const vendor = await getVendor(id);
  if (!vendor) notFound();

  const overviewTab = (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
          {vendor.kind && (
            <>
              <dt className="text-sm font-medium text-muted-foreground self-center">Kind</dt>
              <dd className="text-sm">
                <Badge variant="secondary">{vendor.kind}</Badge>
              </dd>
            </>
          )}
          {vendor.phone && (
            <>
              <dt className="text-sm font-medium text-muted-foreground">Phone</dt>
              <dd className="text-sm">{vendor.phone}</dd>
            </>
          )}
          {vendor.email && (
            <>
              <dt className="text-sm font-medium text-muted-foreground">Email</dt>
              <dd className="text-sm">
                <a href={`mailto:${vendor.email}`} className="underline underline-offset-2">
                  {vendor.email}
                </a>
              </dd>
            </>
          )}
          {vendor.website && (
            <>
              <dt className="text-sm font-medium text-muted-foreground">Website</dt>
              <dd className="text-sm">
                <a
                  href={vendor.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {vendor.website}
                </a>
              </dd>
            </>
          )}
          {vendor.address && (
            <>
              <dt className="text-sm font-medium text-muted-foreground">Address</dt>
              <dd className="text-sm">{vendor.address}</dd>
            </>
          )}
        </dl>
        {vendor.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-2 border-t">
            {vendor.tags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const serviceTab = (
    <>
      {vendor.serviceRecords.length === 0 ? (
        <p className="text-sm text-muted-foreground">No service records yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Performed</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vendor.serviceRecords.map((sr) => (
              <TableRow key={sr.id}>
                <TableCell>
                  <Link href={`/service/${sr.id}`} className="underline underline-offset-2">
                    {sr.performedOn.toISOString().slice(0, 10)}
                  </Link>
                </TableCell>
                <TableCell>
                  {sr.item ? (
                    <Link href={`/items/${sr.item.id}`} className="underline underline-offset-2">
                      {sr.item.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{sr.summary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );

  const notesTab = vendor.notes ? (
    <Markdown>{vendor.notes}</Markdown>
  ) : (
    <p className="text-sm text-muted-foreground">No notes recorded.</p>
  );

  return (
    <DetailPageShell
      header={
        <PageHeader title={vendor.name} actions={<VendorOverflowMenu vendorId={vendor.id} />} />
      }
      meta={<VendorMetaCard vendor={vendor} />}
      tabs={[
        { value: 'overview', label: 'Overview', content: overviewTab },
        { value: 'service', label: 'Service', content: serviceTab },
        { value: 'notes', label: 'Notes', content: notesTab },
      ]}
    />
  );
}
