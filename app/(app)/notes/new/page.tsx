import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'New note' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { NoteForm } from '@/components/notes/NoteForm';
import { createNote } from '@/lib/notes/actions';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewNotePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const prefillItemId = typeof sp.itemId === 'string' ? sp.itemId : undefined;

  const items = await listAllItemsForAutocomplete();

  return (
    <FormPageShell maxWidth="3xl" header={<PageHeader title="Add note" />}>
      <NoteForm
        items={items}
        defaultValues={{ itemId: prefillItemId }}
        action={createNote}
        submitLabel="Save note"
      />
    </FormPageShell>
  );
}
