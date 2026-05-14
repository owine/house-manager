import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { VendorForm } from '@/components/vendors/VendorForm';
import { updateVendor } from '@/lib/vendors/actions';
import { getVendor } from '@/lib/vendors/queries';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const vendor = await getVendor(id);
  return { title: vendor ? `Edit ${vendor.name}` : 'Not found' };
}

export default async function EditVendorPage({ params }: { params: Params }) {
  const { id } = await params;
  const vendor = await getVendor(id);
  if (!vendor) notFound();

  return (
    <FormPageShell header={<PageHeader title={`edit ${vendor.name}`} />}>
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
    </FormPageShell>
  );
}
