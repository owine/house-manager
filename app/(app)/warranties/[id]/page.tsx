import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { Card, CardContent } from '@/components/ui/card';
import { WarrantyStatusBadge } from '@/components/warranties/WarrantyStatusBadge';
import { getWarranty } from '@/lib/warranties/queries';

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

type Params = Promise<{ id: string }>;

export default async function WarrantyDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const warranty = await getWarranty(id);
  if (!warranty) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={warranty.provider}
        description={warranty.item ? `Warranty for ${warranty.item.name}` : undefined}
      />

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="mb-4 flex items-center gap-2">
            <WarrantyStatusBadge endsOn={warranty.endsOn} />
            {warranty.item && (
              <span className="text-sm text-muted-foreground">
                for{' '}
                <Link
                  href={`/items/${warranty.item.id}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {warranty.item.name}
                </Link>
              </span>
            )}
          </div>

          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {warranty.policyNumber && (
              <>
                <dt className="font-semibold">Policy #</dt>
                <dd>{warranty.policyNumber}</dd>
              </>
            )}
            <dt className="font-semibold">Starts on</dt>
            <dd>{warranty.startsOn.toISOString().slice(0, 10)}</dd>
            <dt className="font-semibold">Ends on</dt>
            <dd>{warranty.endsOn.toISOString().slice(0, 10)}</dd>
            {warranty.cost != null && (
              <>
                <dt className="font-semibold">Cost</dt>
                <dd>{currencyFmt.format(warranty.cost.toNumber())}</dd>
              </>
            )}
          </dl>

          {warranty.coverage && (
            <div className="mt-4 border-t pt-4">
              <h2 className="mb-2 text-sm font-semibold">Coverage</h2>
              <p className="whitespace-pre-wrap text-sm">{warranty.coverage}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-2 text-base font-semibold">Files</h2>
        <AttachmentList attachments={warranty.attachments} />
        <AttachmentUploader parentType="warranty" parentId={warranty.id} />
      </section>
    </div>
  );
}
