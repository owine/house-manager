import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'new service record' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ServiceRecordForm } from '@/components/service-records/ServiceRecordForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { listPartsForPicker } from '@/lib/parts/queries';
import { createServiceRecord } from '@/lib/service-records/actions';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { expandSystemSelection } from '@/lib/targets/expand';
import type { PartTargetInput } from '@/lib/targets/schema';
import { listVendors } from '@/lib/vendors/queries';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewServiceRecordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const prefillItemId = typeof sp.itemId === 'string' ? sp.itemId : undefined;
  const prefillSystemId = typeof sp.systemId === 'string' ? sp.systemId : undefined;
  const prefillPartId = typeof sp.partId === 'string' ? sp.partId : undefined;
  const prefillVendorId = typeof sp.vendorId === 'string' ? sp.vendorId : undefined;

  const [availableItems, availableSystems, availableParts, { vendors }] = await Promise.all([
    listAllActiveItemsForPicker(),
    listSystemsWithItemsForPicker(),
    listPartsForPicker(),
    listVendors({ page: 1, pageSize: 200, filters: {} }),
  ]);

  const vendorOptions = vendors.map((v) => ({ id: v.id, name: v.name }));

  // Pre-seed targets from launch context.
  let initialTargets: PartTargetInput[] = [];
  if (prefillItemId) {
    initialTargets = [{ itemId: prefillItemId }];
  } else if (prefillSystemId) {
    const sys = availableSystems.find((s) => s.id === prefillSystemId);
    if (sys) initialTargets = expandSystemSelection([], { id: sys.id, items: sys.items });
  } else if (prefillPartId) {
    initialTargets = [{ partId: prefillPartId }];
  }

  return (
    <FormPageShell header={<PageHeader title="log service" />}>
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        availableParts={availableParts}
        vendors={vendorOptions}
        initialTargets={initialTargets}
        defaultValues={{
          vendorId: prefillVendorId,
        }}
        action={createServiceRecord}
        submitLabel="Save record"
      />
    </FormPageShell>
  );
}
