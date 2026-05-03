import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'New vendor' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { VendorForm } from '@/components/vendors/VendorForm';
import { createVendor } from '@/lib/vendors/actions';

export default function NewVendorPage() {
  return (
    <FormPageShell header={<PageHeader title="New vendor" />}>
      <VendorForm action={createVendor} submitLabel="Create vendor" />
    </FormPageShell>
  );
}
