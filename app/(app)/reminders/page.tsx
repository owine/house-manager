import { Calendar, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';

export const metadata: Metadata = { title: 'reminders' };

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
          title={`reminders (${total})`}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" render={<Link href="/reminders/calendar" />}>
                <Calendar className="h-4 w-4" />
                Calendar
              </Button>
              <Button render={<Link href="/reminders/new" />}>
                <Plus className="h-4 w-4" />
                New reminder
              </Button>
            </div>
          }
        />
      }
      isEmpty={reminders.length === 0}
      empty={
        <EmptyState
          title="no reminders yet."
          action={<Button render={<Link href="/reminders/new" />}>Add your first reminder</Button>}
        />
      }
    >
      <ReminderTable reminders={reminders} />
    </ListPageShell>
  );
}
