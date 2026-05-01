import { notFound } from 'next/navigation';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';
import { updateReminder } from '@/lib/reminders/actions';
import { getReminder } from '@/lib/reminders/queries';
import type { Recurrence } from '@/lib/reminders/schema';

type Params = Promise<{ id: string }>;

export default async function EditReminderPage({ params }: { params: Params }) {
  const { id } = await params;
  const [r, items] = await Promise.all([getReminder(id), listAllItemsForAutocomplete()]);
  if (!r) notFound();

  return (
    <div>
      <h1>Edit reminder</h1>
      <ReminderForm
        items={items}
        defaultValues={{
          id: r.id,
          title: r.title,
          description: r.description ?? '',
          itemId: r.itemId ?? undefined,
          recurrence: r.recurrence as unknown as Recurrence,
          nextDueOn: r.nextDueOn,
          leadTimeDays: r.leadTimeDays,
          autoCreateServiceRecord: r.autoCreateServiceRecord,
        }}
        action={updateReminder}
        submitLabel="Save changes"
      />
    </div>
  );
}
