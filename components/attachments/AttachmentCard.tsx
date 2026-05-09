import { ExternalLink, FileText, Trash2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { deleteAttachment } from '@/lib/attachments/actions';

export type AttachmentRow = {
  id: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  externalUrl: string | null;
  displayLabel: string | null;
  thumbnailPath: string | null;
};

function AttachmentDeleteForm({ id }: { id: string }) {
  async function doDelete() {
    'use server';
    await deleteAttachment(id);
  }
  return (
    <form action={doDelete}>
      <Button
        type="submit"
        variant="ghost"
        size="icon-xs"
        aria-label="Delete attachment"
        className="text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentCard({ a }: { a: AttachmentRow }) {
  const isLink = a.externalUrl != null;
  const isImage = !isLink && (a.mimeType ?? '').startsWith('image/');

  if (isLink) {
    const externalUrl = a.externalUrl ?? '';
    let hostname: string;
    try {
      hostname = new URL(externalUrl).hostname;
    } catch {
      hostname = externalUrl;
    }
    return (
      <Card className="flex flex-col gap-2 p-2">
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col gap-1 no-underline"
        >
          <div className="flex items-center gap-2">
            <ExternalLink className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="break-words font-medium">{a.displayLabel || hostname}</span>
          </div>
          <span className="truncate text-xs text-muted-foreground">{externalUrl}</span>
        </a>
        <div className="flex justify-end">
          <AttachmentDeleteForm id={a.id} />
        </div>
      </Card>
    );
  }

  const href = `/api/files/${a.id}`;
  const thumbHref = a.thumbnailPath ? `/api/files/${a.id}?thumb=1` : href;

  return (
    <Card className="flex flex-col gap-2 p-2">
      {isImage ? (
        <Link href={href} target="_blank" className="block">
          <Image
            src={thumbHref}
            alt={a.filename ?? 'attachment'}
            width={400}
            height={300}
            unoptimized
            className="h-auto w-full rounded-sm"
          />
        </Link>
      ) : (
        <Link href={href} target="_blank" className="block no-underline">
          <CardContent className="flex items-center gap-2 px-0 py-2">
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="break-words font-medium">{a.filename ?? '(no filename)'}</span>
          </CardContent>
        </Link>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{a.sizeBytes !== null ? formatSize(a.sizeBytes) : '–'}</span>
        <AttachmentDeleteForm id={a.id} />
      </div>
    </Card>
  );
}
