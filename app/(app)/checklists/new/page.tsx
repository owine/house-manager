import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'new checklist' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ChecklistAiSection } from '@/components/checklists/ChecklistAiSection';
import { ChecklistMetaForm } from '@/components/checklists/ChecklistMetaForm';
import { requireUser } from '@/lib/auth-guard';
import { createChecklist } from '@/lib/checklists/actions';

export default async function NewChecklistPage() {
  await requireUser();
  return (
    <FormPageShell header={<PageHeader title="new checklist" />}>
      <ChecklistMetaForm action={createChecklist} submitLabel="Create checklist" />
      <ChecklistAiSection />
    </FormPageShell>
  );
}
