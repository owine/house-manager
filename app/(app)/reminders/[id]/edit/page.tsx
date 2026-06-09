import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { updateReminder } from '@/lib/reminders/actions';
import { getReminder } from '@/lib/reminders/queries';
import { parseRecurrence } from '@/lib/reminders/schema';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { toTargetInputs } from '@/lib/targets/schema';

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

  // Drop standalone (both-null) chore targets so the form submits an empty
  // targets list; mapping them to { systemId: null } would fail targetSchema's
  // XOR refine and block every save of a standalone chore.
  const initialTargets = toTargetInputs(r.targets);

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
          recurrence: parseRecurrence(r.recurrence),
          nextDueOn: r.nextDueOn ?? new Date(),
          leadTimeDays: r.leadTimeDays,
          autoCreateServiceRecord: r.autoCreateServiceRecord,
          autoComplete: r.autoComplete,
        }}
        action={updateReminder}
        submitLabel="Save changes"
        kind={r.kind}
      />
    </FormPageShell>
  );
}
