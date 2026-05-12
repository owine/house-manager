import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { createReminder } from '@/lib/reminders/actions';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { expandSystemSelection } from '@/lib/targets/expand';
import type { TargetInput } from '@/lib/targets/schema';

export const metadata: Metadata = { title: 'New chore' };

type SearchParams = Promise<{ itemId?: string; systemId?: string }>;

export default async function NewChorePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const [availableItems, availableSystems] = await Promise.all([
    listAllActiveItemsForPicker(),
    listSystemsWithItemsForPicker(),
  ]);

  let initialTargets: TargetInput[] = [];
  if (sp.itemId) {
    initialTargets = [{ itemId: sp.itemId }];
  } else if (sp.systemId) {
    const sys = availableSystems.find((s) => s.id === sp.systemId);
    if (sys) initialTargets = expandSystemSelection([], { id: sys.id, items: sys.items });
  }

  return (
    <FormPageShell header={<PageHeader title="New chore" />}>
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={initialTargets}
        action={createReminder}
        submitLabel="Create chore"
        kind="CHORE"
      />
    </FormPageShell>
  );
}
