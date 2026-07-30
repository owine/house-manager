import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { PartForm } from '@/components/parts/PartForm';
import { createPart } from '@/lib/parts/actions';

export const metadata: Metadata = { title: 'new part' };

export default function NewPartPage() {
  return (
    <FormPageShell header={<PageHeader title="new part" />}>
      <PartForm action={createPart} submitLabel="Create part" />
    </FormPageShell>
  );
}
