import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ChecklistEditor } from '@/components/checklists/ChecklistEditor';
import { getChecklist } from '@/lib/checklists/queries';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const checklist = await getChecklist(id);
  return { title: checklist?.name ?? 'Not found' };
}

export default async function ChecklistDetailPage({ params }: Props) {
  const { id } = await params;
  const checklist = await getChecklist(id);
  if (!checklist) notFound();

  return (
    <FormPageShell header={<PageHeader title={checklist.name} />}>
      <ChecklistEditor checklist={checklist} />
    </FormPageShell>
  );
}
