import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ServiceRecordForm } from '@/components/service-records/ServiceRecordForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { updateServiceRecord } from '@/lib/service-records/actions';
import { getServiceRecord } from '@/lib/service-records/queries';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import type { TargetInput } from '@/lib/targets/schema';
import { listVendors } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export const metadata: Metadata = { title: 'edit service record' };

export default async function EditServiceRecordPage({ params }: { params: Params }) {
  const { id } = await params;
  const [record, availableItems, availableSystems, { vendors }] = await Promise.all([
    getServiceRecord(id),
    listAllActiveItemsForPicker(),
    listSystemsWithItemsForPicker(),
    listVendors({ page: 1, pageSize: 200, filters: {} }),
  ]);
  if (!record) notFound();

  const vendorOptions = vendors.map((v) => ({ id: v.id, name: v.name }));
  const initialTargets: TargetInput[] = record.targets.map((t) =>
    t.itemId ? { itemId: t.itemId } : { systemId: t.systemId as string },
  );

  return (
    <FormPageShell header={<PageHeader title="edit service record" />}>
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        vendors={vendorOptions}
        initialTargets={initialTargets}
        defaultValues={{
          id: record.id,
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
