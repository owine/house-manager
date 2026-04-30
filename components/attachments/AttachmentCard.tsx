import Image from 'next/image';
import Link from 'next/link';
import type React from 'react';
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
      <button
        type="submit"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--danger)',
          font: 'inherit',
          fontSize: '0.85rem',
        }}
      >
        Delete
      </button>
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
  const cardStyle: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '0.5rem',
    background: 'var(--bg-elevated)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  };

  if (isLink) {
    // externalUrl is non-null when isLink is true; assign to a local string to avoid non-null assertions
    const externalUrl = a.externalUrl ?? '';
    let hostname: string;
    try {
      hostname = new URL(externalUrl).hostname;
    } catch {
      hostname = externalUrl;
    }
    return (
      <div style={cardStyle}>
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            textDecoration: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.5rem' }}>🔗</span>
            <span style={{ wordBreak: 'break-word' }}>{a.displayLabel || hostname}</span>
          </div>
          <span
            style={{
              fontSize: '0.75rem',
              color: 'var(--fg-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {externalUrl}
          </span>
        </a>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            fontSize: '0.8rem',
            color: 'var(--fg-muted)',
          }}
        >
          <AttachmentDeleteForm id={a.id} />
        </div>
      </div>
    );
  }

  const href = `/api/files/${a.id}`;
  const thumbHref = a.thumbnailPath ? `/api/files/${a.id}?thumb=1` : href;

  return (
    <div style={cardStyle}>
      {isImage ? (
        <Link href={href} target="_blank">
          <Image
            src={thumbHref}
            alt={a.filename ?? 'attachment'}
            width={400}
            height={300}
            unoptimized
            style={{ width: '100%', height: 'auto', borderRadius: '3px' }}
          />
        </Link>
      ) : (
        <Link href={href} target="_blank" style={{ textDecoration: 'none' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '1rem 0',
            }}
          >
            <span style={{ fontSize: '1.5rem' }}>📄</span>
            <span style={{ wordBreak: 'break-word' }}>{a.filename ?? '(no filename)'}</span>
          </div>
        </Link>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '0.8rem',
          color: 'var(--fg-muted)',
        }}
      >
        <span>{a.sizeBytes !== null ? formatSize(a.sizeBytes) : '–'}</span>
        <AttachmentDeleteForm id={a.id} />
      </div>
    </div>
  );
}
