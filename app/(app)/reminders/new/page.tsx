import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'New reminder' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { createReminder } from '@/lib/reminders/actions';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { expandSystemSelection } from '@/lib/targets/expand';
import type { TargetInput } from '@/lib/targets/schema';

type SearchParams = Promise<{ itemId?: string; systemId?: string }>;

export default async function NewReminderPage({ searchParams }: { searchParams: SearchParams }) {
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
    <FormPageShell header={<PageHeader title="New reminder" />}>
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={initialTargets}
        action={createReminder}
        submitLabel="Create reminder"
      />
    </FormPageShell>
  );
}
