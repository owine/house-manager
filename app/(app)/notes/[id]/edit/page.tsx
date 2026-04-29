import { notFound } from 'next/navigation';
import { NoteForm } from '@/components/notes/NoteForm';
import { updateNote } from '@/lib/notes/actions';
import { getNote, listAllItemsForAutocomplete } from '@/lib/notes/queries';

type Params = Promise<{ id: string }>;

export default async function EditNotePage({ params }: { params: Params }) {
  const { id } = await params;
  const [note, items] = await Promise.all([getNote(id), listAllItemsForAutocomplete()]);
  if (!note) notFound();

  return (
    <div>
      <h1>Edit note</h1>
      <NoteForm
        items={items}
        defaultValues={{
          id: note.id,
          title: note.title,
          body: note.body,
          itemId: note.itemId ?? undefined,
          tags: note.tags,
        }}
        action={updateNote}
        submitLabel="Save changes"
      />
    </div>
  );
}
