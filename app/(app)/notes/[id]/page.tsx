import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AttachmentUploader } from '@/components/attachments/AttachmentUploader';
import { NoteOverflowMenu } from '@/components/notes/NoteOverflowMenu';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { LocalDate } from '@/components/ui/LocalDate';
import { Markdown } from '@/lib/markdown';
import { getNote } from '@/lib/notes/queries';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const note = await getNote(id);
  return { title: note?.title ?? 'Not found' };
}

export default async function NoteDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const note = await getNote(id);
  if (!note) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={note.title} actions={<NoteOverflowMenu noteId={note.id} />} />

      {/* Meta */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {note.item && (
          <Link
            href={`/items/${note.item.id}`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {note.item.name}
          </Link>
        )}
        {note.item && note.tags.length > 0 && <span className="text-muted-foreground/50">·</span>}
        {note.tags.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {note.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </span>
        )}
        <span className="ml-auto text-xs">
          Updated <LocalDate iso={note.updatedAt.toISOString()} />
        </span>
      </div>

      {/* Body */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <Markdown>{note.body}</Markdown>
        </CardContent>
      </Card>

      {/* Attachments */}
      <section>
        <h2 className="mb-2 text-base font-semibold">Files</h2>
        <AttachmentList attachments={note.attachments} />
        <AttachmentUploader parentType="note" parentId={note.id} />
      </section>
    </div>
  );
}
