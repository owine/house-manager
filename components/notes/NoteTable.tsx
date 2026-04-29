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
          <th className="table-cell">Title</th>
          <th className="table-cell">Attached to</th>
          <th className="table-cell">Tags</th>
          <th className="table-cell">Updated</th>
        </tr>
      </thead>
      <tbody>
        {notes.map((note) => (
          <tr key={note.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td className="table-cell">
              <Link href={`/notes/${note.id}`}>{note.title}</Link>
            </td>
            <td className="table-cell">
              {note.item ? (
                <Link
                  href={`/items/${note.item.id}`}
                  className="badge"
                  style={{ textDecoration: 'none' }}
                >
                  📎 {note.item.name}
                </Link>
              ) : (
                '—'
              )}
            </td>
            <td className="table-cell">
              {note.tags.length > 0 ? (
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {note.tags.map((tag) => (
                    <span key={tag} className="badge">
                      {tag}
                    </span>
                  ))}
                </span>
              ) : (
                '—'
              )}
            </td>
            <td
              className="table-cell"
              style={{
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
