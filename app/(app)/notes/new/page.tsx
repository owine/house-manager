import { NoteForm } from '@/components/notes/NoteForm';
import { createNote } from '@/lib/notes/actions';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewNotePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const prefillItemId = typeof sp.itemId === 'string' ? sp.itemId : undefined;

  const items = await listAllItemsForAutocomplete();

  return (
    <div>
      <h1>Add note</h1>
      <NoteForm
        items={items}
        defaultValues={{ itemId: prefillItemId }}
        action={createNote}
        submitLabel="Save note"
      />
    </div>
  );
}
