import { AttachmentCard, type AttachmentRow } from './AttachmentCard';
import { AttachmentScrollHighlight } from './AttachmentScrollHighlight';

export function AttachmentList({ attachments }: { attachments: AttachmentRow[] }) {
  if (attachments.length === 0) {
    return <p className="text-sm text-muted-foreground">no files yet.</p>;
  }
  return (
    <>
      <AttachmentScrollHighlight />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {attachments.map((a) => (
          <AttachmentCard key={a.id} a={a} />
        ))}
      </div>
    </>
  );
}
