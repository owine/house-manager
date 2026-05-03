import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'New reminder' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';
import { createReminder } from '@/lib/reminders/actions';

type SearchParams = Promise<{ itemId?: string }>;

export default async function NewReminderPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const items = await listAllItemsForAutocomplete();
  return (
    <FormPageShell header={<PageHeader title="New reminder" />}>
      <ReminderForm
        items={items}
        defaultValues={sp.itemId ? { itemId: sp.itemId } : undefined}
        action={createReminder}
        submitLabel="Create reminder"
      />
    </FormPageShell>
  );
}
