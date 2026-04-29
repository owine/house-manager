import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { NoteTable } from '@/components/notes/NoteTable';
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
  const isEmpty = notes.length === 0 && !hasFilters;

  return (
    <div>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
        }}
      >
        <h1>Notes ({total})</h1>
        <Link href="/notes/new">+ Add note</Link>
      </header>

      {/* Filter form */}
      <form
        method="get"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          alignItems: 'flex-end',
        }}
      >
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Search
          <input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Search title or body…"
            style={{
              padding: '0.3rem 0.5rem',
              border: '1px solid var(--border-strong)',
              borderRadius: '4px',
            }}
          />
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Item
          <select
            name="itemId"
            defaultValue={params.filters.itemId?.[0] ?? ''}
            style={{
              padding: '0.3rem 0.5rem',
              border: '1px solid var(--border-strong)',
              borderRadius: '4px',
            }}
          >
            <option value="">All items</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          style={{
            padding: '0.3rem 0.75rem',
            borderRadius: '4px',
            border: '1px solid var(--border-strong)',
            cursor: 'pointer',
          }}
        >
          Filter
        </button>

        {hasFilters && (
          <Link
            href="/notes"
            style={{ padding: '0.3rem 0.75rem', fontSize: '0.85rem', alignSelf: 'flex-end' }}
          >
            Clear
          </Link>
        )}
      </form>

      {isEmpty ? (
        <EmptyState
          message="No notes yet."
          action={<Link href="/notes/new">Add your first note</Link>}
        />
      ) : notes.length === 0 ? (
        <EmptyState
          message="No notes match your filters."
          action={<Link href="/notes">Clear filters</Link>}
        />
      ) : (
        <NoteTable notes={notes} />
      )}
    </div>
  );
}
