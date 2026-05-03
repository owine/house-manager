import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ServiceRecordForm } from '@/components/service-records/ServiceRecordForm';
import { listItems } from '@/lib/items/queries';
import { updateServiceRecord } from '@/lib/service-records/actions';
import { getServiceRecord } from '@/lib/service-records/queries';
import { listVendors } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export default async function EditServiceRecordPage({ params }: { params: Params }) {
  const { id } = await params;
  const [record, { items }, { vendors }] = await Promise.all([
    getServiceRecord(id),
    listItems({ page: 1, pageSize: 200, filters: {} }),
    listVendors({ page: 1, pageSize: 200, filters: {} }),
  ]);
  if (!record) notFound();

  const itemOptions = items.map((i) => ({ id: i.id, name: i.name }));
  const vendorOptions = vendors.map((v) => ({ id: v.id, name: v.name }));

  return (
    <FormPageShell header={<PageHeader title="Edit service record" />}>
      <ServiceRecordForm
        items={itemOptions}
        vendors={vendorOptions}
        defaultValues={{
          id: record.id,
          itemId: record.itemId ?? undefined,
          vendorId: record.vendorId ?? undefined,
          performedOn: record.performedOn,
          cost: record.cost?.toNumber() ?? undefined,
          summary: record.summary,
          notes: record.notes ?? undefined,
        }}
        action={updateServiceRecord}
        submitLabel="Save changes"
      />
    </FormPageShell>
  );
}
