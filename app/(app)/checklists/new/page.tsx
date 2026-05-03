import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'New checklist' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ChecklistMetaForm } from '@/components/checklists/ChecklistMetaForm';
import { createChecklist } from '@/lib/checklists/actions';

export default function NewChecklistPage() {
  return (
    <FormPageShell header={<PageHeader title="New checklist" />}>
      <ChecklistMetaForm action={createChecklist} submitLabel="Create checklist" />
    </FormPageShell>
  );
}
