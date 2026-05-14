import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { getVendor } from '@/lib/vendors/queries';

type Vendor = NonNullable<Awaited<ReturnType<typeof getVendor>>>;

type MetaRowProps = { label: string; children: React.ReactNode };

function MetaRow({ label, children }: MetaRowProps) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

type Props = { vendor: Vendor };

export function VendorMetaCard({ vendor }: Props) {
  const hasAny = vendor.phone || vendor.email || vendor.website || vendor.address;

  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <CardTitle>Contact</CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {!hasAny ? (
          <p className="text-sm text-muted-foreground">no contact details recorded.</p>
        ) : (
          <dl className="flex flex-col gap-3">
            {vendor.phone && <MetaRow label="Phone">{vendor.phone}</MetaRow>}
            {vendor.email && (
              <MetaRow label="Email">
                <a href={`mailto:${vendor.email}`} className="underline underline-offset-2">
                  {vendor.email}
                </a>
              </MetaRow>
            )}
            {vendor.website && (
              <MetaRow label="Website">
                <a
                  href={vendor.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {vendor.website}
                </a>
              </MetaRow>
            )}
            {vendor.address && <MetaRow label="Address">{vendor.address}</MetaRow>}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
