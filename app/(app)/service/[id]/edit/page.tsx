import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ServiceRecordForm } from '@/components/service-records/ServiceRecordForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { listPartsForPicker } from '@/lib/parts/queries';
import { updateServiceRecord } from '@/lib/service-records/actions';
import { getServiceRecord } from '@/lib/service-records/queries';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { toTargetInputs } from '@/lib/targets/schema';
import { listVendors } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export const metadata: Metadata = { title: 'edit service record' };

export default async function EditServiceRecordPage({ params }: { params: Params }) {
  const { id } = await params;
  const [record, availableItems, availableSystems, availableParts, { vendors }] = await Promise.all(
    [
      getServiceRecord(id),
      listAllActiveItemsForPicker(),
      listSystemsWithItemsForPicker(),
      listPartsForPicker(),
      listVendors({ page: 1, pageSize: 200, filters: {} }),
    ],
  );
  if (!record) notFound();

  const vendorOptions = vendors.map((v) => ({ id: v.id, name: v.name }));
  // Use the shared mapper rather than an inline copy: the duplicate is what hid
  // part targets from this page (a part row mapped to `{ systemId: null }`, which
  // then failed the XOR refine or submitted garbage that updateServiceRecord's
  // diff deleted). The form chain now carries PartTargetInput end to end, so a
  // part target is both editable and preserved on an untouched save.
  const initialTargets = toTargetInputs(record.targets);

  return (
    <FormPageShell header={<PageHeader title="edit service record" />}>
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        availableParts={availableParts}
        vendors={vendorOptions}
        initialTargets={initialTargets}
        defaultValues={{
          id: record.id,
          selfPerformed: record.selfPerformed,
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
