import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';
import { createReminder } from '@/lib/reminders/actions';

type SearchParams = Promise<{ itemId?: string }>;

export default async function NewReminderPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const items = await listAllItemsForAutocomplete();
  return (
    <div>
      <h1>New reminder</h1>
      <ReminderForm
        items={items}
        defaultValues={sp.itemId ? { itemId: sp.itemId } : undefined}
        action={createReminder}
        submitLabel="Create reminder"
      />
    </div>
  );
}
