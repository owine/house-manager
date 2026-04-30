import { AttachmentCard, type AttachmentRow } from './AttachmentCard';

export function AttachmentList({ attachments }: { attachments: AttachmentRow[] }) {
  if (attachments.length === 0) {
    return <p style={{ color: 'var(--fg-muted)' }}>No files yet.</p>;
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: '0.75rem',
      }}
    >
      {attachments.map((a) => (
        <AttachmentCard key={a.id} a={a} />
      ))}
    </div>
  );
}
