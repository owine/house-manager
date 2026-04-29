import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Markdown } from '@/lib/markdown';
import { deleteNote } from '@/lib/notes/actions';
import { getNote } from '@/lib/notes/queries';

type Params = Promise<{ id: string }>;

export default async function NoteDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const note = await getNote(id);
  if (!note) notFound();

  const noteId = note.id;

  async function doDelete() {
    'use server';
    await deleteNote(noteId);
    redirect('/notes');
  }

  return (
    <div>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '1.5rem',
        }}
      >
        <div>
          <p style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
            <Link href="/notes">Notes</Link>
          </p>
          <h1 style={{ margin: 0 }}>{note.title}</h1>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
          <Link href={`/notes/${note.id}/edit`}>Edit</Link>
          <form action={doDelete}>
            <button
              type="submit"
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--danger)',
                font: 'inherit',
              }}
            >
              Delete
            </button>
          </form>
        </div>
      </header>

      {/* Metadata */}
      <div
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
        }}
      >
        {note.item && (
          <Link
            href={`/items/${note.item.id}`}
            style={{
              background: 'var(--badge-bg)',
              padding: '0.1rem 0.4rem',
              borderRadius: '4px',
              fontSize: '0.85rem',
              textDecoration: 'none',
            }}
          >
            📎 {note.item.name}
          </Link>
        )}

        {note.tags.length > 0 && (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {note.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  background: 'var(--badge-bg)',
                  padding: '0.1rem 0.35rem',
                  borderRadius: '3px',
                  fontSize: '0.8rem',
                }}
              >
                {tag}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Body */}
      <section>
        <Markdown>{note.body}</Markdown>
      </section>
    </div>
  );
}
