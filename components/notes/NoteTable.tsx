import Link from 'next/link';

type NoteRow = {
  id: string;
  title: string;
  item: { id: string; name: string } | null;
  tags: string[];
  updatedAt: Date;
};

export function NoteTable({ notes }: { notes: NoteRow[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th style={{ padding: '0.5rem' }}>Title</th>
          <th style={{ padding: '0.5rem' }}>Attached to</th>
          <th style={{ padding: '0.5rem' }}>Tags</th>
          <th style={{ padding: '0.5rem' }}>Updated</th>
        </tr>
      </thead>
      <tbody>
        {notes.map((note) => (
          <tr key={note.id} style={{ borderBottom: '1px solid var(--bg-elevated)' }}>
            <td style={{ padding: '0.5rem' }}>
              <Link href={`/notes/${note.id}`}>{note.title}</Link>
            </td>
            <td style={{ padding: '0.5rem' }}>
              {note.item ? (
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
              ) : (
                '—'
              )}
            </td>
            <td style={{ padding: '0.5rem' }}>
              {note.tags.length > 0 ? (
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
              ) : (
                '—'
              )}
            </td>
            <td
              style={{
                padding: '0.5rem',
                whiteSpace: 'nowrap',
                fontSize: '0.85rem',
                color: 'var(--fg-muted)',
              }}
            >
              {note.updatedAt.toISOString().slice(0, 10)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
