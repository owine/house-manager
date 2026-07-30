import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { listPartsForPicker } from '@/lib/parts/queries';
import { createReminder } from '@/lib/reminders/actions';
import { listSystemsWithItemsForPicker } from '@/lib/systems/queries';
import { expandSystemSelection } from '@/lib/targets/expand';
import type { PartTargetInput } from '@/lib/targets/schema';

export const metadata: Metadata = { title: 'new chore' };

type SearchParams = Promise<{ itemId?: string; systemId?: string; partId?: string }>;

export default async function NewChorePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const [availableItems, availableSystems, availableParts] = await Promise.all([
    listAllActiveItemsForPicker(),
    listSystemsWithItemsForPicker(),
    listPartsForPicker(),
  ]);

  let initialTargets: PartTargetInput[] = [];
  if (sp.itemId) {
    initialTargets = [{ itemId: sp.itemId }];
  } else if (sp.systemId) {
    const sys = availableSystems.find((s) => s.id === sp.systemId);
    if (sys) initialTargets = expandSystemSelection([], { id: sys.id, items: sys.items });
  } else if (sp.partId) {
    initialTargets = [{ partId: sp.partId }];
  }

  return (
    <FormPageShell header={<PageHeader title="new chore" />}>
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        availableParts={availableParts}
        initialTargets={initialTargets}
        action={createReminder}
        submitLabel="Create chore"
        kind="CHORE"
      />
    </FormPageShell>
  );
}
