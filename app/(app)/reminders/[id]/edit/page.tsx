import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { updateReminder } from '@/lib/reminders/actions';
import { getReminder } from '@/lib/reminders/queries';
import type { Recurrence } from '@/lib/reminders/schema';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import type { TargetInput } from '@/lib/targets/schema';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const r = await getReminder(id);
  return { title: r ? `Edit ${r.title}` : 'Not found' };
}

export default async function EditReminderPage({ params }: { params: Params }) {
  const { id } = await params;
  const [r, availableItems, availableSystems] = await Promise.all([
    getReminder(id),
    listAllActiveItemsForPicker(),
    listSystemsWithItemsForPicker(),
  ]);
  if (!r) notFound();

  const initialTargets: TargetInput[] = r.targets.map((t) =>
    t.itemId ? { itemId: t.itemId } : { systemId: t.systemId as string },
  );

  const isChore = r.kind === 'CHORE';
  return (
    <FormPageShell header={<PageHeader title={isChore ? 'Edit chore' : 'Edit reminder'} />}>
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={initialTargets}
        defaultValues={{
          id: r.id,
          title: r.title,
          description: r.description ?? '',
          recurrence: r.recurrence as unknown as Recurrence,
          nextDueOn: r.nextDueOn ?? new Date(),
          leadTimeDays: r.leadTimeDays,
          autoCreateServiceRecord: r.autoCreateServiceRecord,
        }}
        action={updateReminder}
        submitLabel="Save changes"
        kind={r.kind}
      />
    </FormPageShell>
  );
}
