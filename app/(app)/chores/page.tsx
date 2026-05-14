import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ReminderTable } from '@/components/reminders/ReminderTable';
import { Button } from '@/components/ui/button';
import { listReminders } from '@/lib/reminders/queries';
import { parseListParams } from '@/lib/url-params';

export const metadata: Metadata = { title: 'chores' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Chores are the ambient-cadence sibling of reminders — same underlying
// table, just kind=CHORE so the reminders-tick worker leaves them alone.
// This page is a filtered view; the table itself is the same component as
// /reminders to keep markup in lockstep.
export default async function ChoresPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') sp.set(k, v);
  const params = parseListParams(sp);
  const { reminders, total } = await listReminders(params, 'CHORE');

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`chores (${total})`}
          actions={
            <Button render={<Link href="/chores/new" />}>
              <Plus className="h-4 w-4" />
              New chore
            </Button>
          }
        />
      }
      isEmpty={reminders.length === 0}
      empty={
        <EmptyState
          title="no chores yet."
          description="Chores are recurring tasks that don't send notifications — perfect for weekly trash, monthly furnace filter, quarterly gutter check."
          action={<Button render={<Link href="/chores/new" />}>add your first chore</Button>}
        />
      }
    >
      <ReminderTable reminders={reminders} />
    </ListPageShell>
  );
}
