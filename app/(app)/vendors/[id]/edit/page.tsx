import { notFound } from 'next/navigation';
import { VendorForm } from '@/components/vendors/VendorForm';
import { updateVendor } from '@/lib/vendors/actions';
import { getVendor } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export default async function EditVendorPage({ params }: { params: Params }) {
  const { id } = await params;
  const vendor = await getVendor(id);
  if (!vendor) notFound();

  return (
    <div>
      <h1>Edit vendor</h1>
      <VendorForm
        defaultValues={{
          id: vendor.id,
          name: vendor.name,
          kind: vendor.kind ?? undefined,
          phone: vendor.phone ?? undefined,
          email: vendor.email ?? undefined,
          website: vendor.website ?? undefined,
          address: vendor.address ?? undefined,
          notes: vendor.notes ?? undefined,
          tags: vendor.tags,
        }}
        action={updateVendor}
        submitLabel="Save changes"
      />
    </div>
  );
}
