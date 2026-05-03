import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { ServiceRecordOverflowMenu } from '@/components/service-records/ServiceRecordOverflowMenu';
import { Card, CardContent } from '@/components/ui/card';
import { Markdown } from '@/lib/markdown';
import { getServiceRecord } from '@/lib/service-records/queries';

type Params = Promise<{ id: string }>;

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export default async function ServiceRecordDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const record = await getServiceRecord(id);
  if (!record) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={record.summary}
        actions={<ServiceRecordOverflowMenu recordId={record.id} />}
      />

      <Card className="mb-6">
        <CardContent className="pt-6">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="font-semibold">Performed on</dt>
            <dd>{record.performedOn.toISOString().slice(0, 10)}</dd>

            {record.item && (
              <>
                <dt className="font-semibold">Item</dt>
                <dd>
                  <Link href={`/items/${record.item.id}`} className="underline underline-offset-2">
                    {record.item.name}
                  </Link>
                </dd>
              </>
            )}

            {record.vendor && (
              <>
                <dt className="font-semibold">Vendor</dt>
                <dd>
                  <Link
                    href={`/vendors/${record.vendor.id}`}
                    className="underline underline-offset-2"
                  >
                    {record.vendor.name}
                  </Link>
                </dd>
              </>
            )}

            {record.cost != null && (
              <>
                <dt className="font-semibold">Cost</dt>
                <dd>{currencyFmt.format(record.cost.toNumber())}</dd>
              </>
            )}
          </dl>

          {record.notes && (
            <div className="mt-4 border-t pt-4">
              <h2 className="mb-2 text-sm font-semibold">Notes</h2>
              <Markdown>{record.notes}</Markdown>
            </div>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-2 text-base font-semibold">Files</h2>
        <AttachmentList attachments={record.attachments} />
        <AttachmentUploader parentType="serviceRecord" parentId={record.id} />
      </section>
    </div>
  );
}
