import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { SystemForm } from '@/components/systems/SystemForm';
import { requireUser } from '@/lib/auth-guard';
import { createSystem } from '@/lib/systems/actions';

export const metadata: Metadata = { title: 'new system' };

export default async function NewSystemPage() {
  await requireUser();
  return (
    <FormPageShell header={<PageHeader title="new system" />}>
      <SystemForm action={createSystem} submitLabel="Create system" />
    </FormPageShell>
  );
}
