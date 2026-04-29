import { ServiceRecordForm } from '@/components/service-records/ServiceRecordForm';
import { listItems } from '@/lib/items/queries';
import { createServiceRecord } from '@/lib/service-records/actions';
import { listVendors } from '@/lib/vendors/queries';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewServiceRecordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const prefillItemId = typeof sp.itemId === 'string' ? sp.itemId : undefined;
  const prefillVendorId = typeof sp.vendorId === 'string' ? sp.vendorId : undefined;

  const [{ items }, { vendors }] = await Promise.all([
    listItems({ page: 1, pageSize: 200, filters: {} }),
    listVendors({ page: 1, pageSize: 200, filters: {} }),
  ]);

  const itemOptions = items.map((i) => ({ id: i.id, name: i.name }));
  const vendorOptions = vendors.map((v) => ({ id: v.id, name: v.name }));

  return (
    <div>
      <h1>Log service</h1>
      <ServiceRecordForm
        items={itemOptions}
        vendors={vendorOptions}
        defaultValues={{
          itemId: prefillItemId,
          vendorId: prefillVendorId,
        }}
        action={createServiceRecord}
        submitLabel="Save record"
      />
    </div>
  );
}
