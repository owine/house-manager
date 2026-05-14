import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';

export const metadata: Metadata = { title: 'notes' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { NoteCardGrid } from '@/components/notes/NoteCardGrid';
import { NotesFilterBar } from '@/components/notes/NotesFilterBar';
import { Button } from '@/components/ui/button';
import { listAllItemsForAutocomplete, listNotes } from '@/lib/notes/queries';
import { parseListParams } from '@/lib/url-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NotesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v);
  }

  const params = parseListParams(sp);
  const [{ notes, total }, items] = await Promise.all([
    listNotes(params),
    listAllItemsForAutocomplete(),
  ]);

  const hasFilters = !!params.q || Object.keys(params.filters).length > 0;
  const noNotesAtAll = notes.length === 0 && !hasFilters;

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`notes (${total})`}
          actions={
            <Button render={<Link href="/notes/new" />}>
              <Plus className="h-4 w-4" />
              Add note
            </Button>
          }
        />
      }
      filters={
        <NotesFilterBar
          q={params.q ?? ''}
          selectedItemId={params.filters.itemId?.[0] ?? ''}
          items={items}
        />
      }
      isEmpty={notes.length === 0}
      empty={
        noNotesAtAll ? (
          <EmptyState
            title="no notes yet."
            action={<Button render={<Link href="/notes/new" />}>Add your first note</Button>}
          />
        ) : (
          <EmptyState
            title="no notes match your filters."
            action={
              <Button variant="ghost" render={<Link href="/notes" />}>
                Clear filters
              </Button>
            }
          />
        )
      }
    >
      <NoteCardGrid notes={notes} />
    </ListPageShell>
  );
}
