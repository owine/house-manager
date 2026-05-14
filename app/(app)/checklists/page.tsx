import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';

export const metadata: Metadata = { title: 'checklists' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { ChecklistCard } from '@/components/checklists/ChecklistCard';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { listChecklists } from '@/lib/checklists/queries';

type SearchParams = Promise<{ archived?: string }>;

export default async function ChecklistsPage({ searchParams }: { searchParams: SearchParams }) {
  const { archived } = await searchParams;
  const showArchived = archived === '1' || archived === 'true';
  const checklists = await listChecklists({ includeArchived: showArchived });
  const isEmpty = checklists.length === 0;

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`checklists (${checklists.length})`}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                render={<Link href={showArchived ? '/checklists' : '/checklists?archived=1'} />}
              >
                {showArchived ? 'Active only' : 'Show archived'}
              </Button>
              <Button render={<Link href="/checklists/new" />}>
                <Plus className="h-4 w-4" />
                New checklist
              </Button>
            </div>
          }
        />
      }
      isEmpty={isEmpty}
      empty={
        <EmptyState
          title={showArchived ? 'No archived checklists' : 'No checklists yet'}
          description={
            showArchived
              ? 'Switch back to active to see your live checklists.'
              : 'Create one manually, or generate one from the dashboard.'
          }
          action={
            <Button render={<Link href="/checklists/new" />}>
              <Plus className="h-4 w-4" />
              New checklist
            </Button>
          }
        />
      }
    >
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {checklists.map((c) => (
          <li key={c.id}>
            <ChecklistCard checklist={c} />
          </li>
        ))}
      </ul>
    </ListPageShell>
  );
}
