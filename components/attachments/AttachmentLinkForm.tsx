'use client';
import type React from 'react';
import { useState, useTransition } from 'react';
import { addAttachmentLink } from '@/lib/attachments/actions';
import type { ParentType } from '@/lib/attachments/schema';

type Props = {
  parentType: ParentType;
  parentId: string;
};

export function AttachmentLinkForm({ parentType, parentId }: Props) {
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set('parentType', parentType);
      fd.set('parentId', parentId);
      fd.set('externalUrl', url);
      if (label) fd.set('displayLabel', label);
      const result = await addAttachmentLink(fd);
      if (result.ok) {
        setUrl('');
        setLabel('');
      } else {
        setError(result.formError ?? 'Could not add link');
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        marginTop: '0.75rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid var(--border)',
        alignItems: 'flex-end',
      }}
    >
      <label
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 200px',
          fontSize: '0.85rem',
        }}
      >
        Label (optional)
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={pending}
          style={{ padding: '0.25rem 0.4rem', marginTop: '0.15rem' }}
        />
      </label>
      <label
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '2 1 320px',
          fontSize: '0.85rem',
        }}
      >
        URL (https or http)
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder="https://drive.proton.me/..."
          disabled={pending}
          style={{ padding: '0.25rem 0.4rem', marginTop: '0.15rem' }}
        />
      </label>
      <button
        type="submit"
        disabled={pending || url === ''}
        style={{ padding: '0.4rem 0.75rem', cursor: 'pointer' }}
      >
        {pending ? 'Adding…' : 'Add link'}
      </button>
      {error && (
        <p
          style={{
            flex: '1 1 100%',
            fontSize: '0.85rem',
            color: 'var(--danger)',
            margin: 0,
          }}
        >
          {error}
        </p>
      )}
    </form>
  );
}
