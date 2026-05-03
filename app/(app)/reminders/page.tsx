import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';

export const metadata: Metadata = { title: 'Reminders' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ReminderTable } from '@/components/reminders/ReminderTable';
import { Button } from '@/components/ui/button';
import { listReminders } from '@/lib/reminders/queries';
import { parseListParams } from '@/lib/url-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RemindersPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') sp.set(k, v);
  const params = parseListParams(sp);
  const { reminders, total } = await listReminders(params);

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`Reminders (${total})`}
          actions={
            <Button render={<Link href="/reminders/new" />}>
              <Plus className="h-4 w-4" />
              New reminder
            </Button>
          }
        />
      }
      isEmpty={reminders.length === 0}
      empty={
        <EmptyState
          title="No reminders yet."
          action={<Button render={<Link href="/reminders/new" />}>Add your first reminder</Button>}
        />
      }
    >
      <ReminderTable reminders={reminders} />
    </ListPageShell>
  );
}
