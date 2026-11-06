import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'new vendor' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { VendorForm } from '@/components/vendors/VendorForm';
import { requireUser } from '@/lib/auth-guard';
import { createVendor } from '@/lib/vendors/actions';

export default async function NewVendorPage() {
  await requireUser();
  return (
    <FormPageShell header={<PageHeader title="new vendor" />}>
      <VendorForm action={createVendor} submitLabel="Create vendor" />
    </FormPageShell>
  );
}
