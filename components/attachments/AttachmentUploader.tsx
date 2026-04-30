'use client';
import type React from 'react';
import { useRef, useState, useTransition } from 'react';
import { uploadAttachment } from '@/lib/attachments/actions';
import type { ParentType } from '@/lib/attachments/schema';

type Status = { name: string; state: 'pending' | 'ok' | 'error'; error?: string };

type Props = {
  parentType: ParentType;
  parentId: string;
};

export function AttachmentUploader({ parentType, parentId }: Props) {
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<Status[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setItems(files.map((f) => ({ name: f.name, state: 'pending' as const })));
    startTransition(async () => {
      const next: Status[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.set('parentType', parentType);
        fd.set('parentId', parentId);
        fd.set('file', f);
        const result = await uploadAttachment(fd);
        if (result.ok) {
          next.push({ name: f.name, state: 'ok' });
        } else {
          next.push({ name: f.name, state: 'error', error: result.formError ?? 'Upload failed' });
        }
        setItems([
          ...next,
          ...files
            .slice(next.length)
            .map((rest) => ({ name: rest.name, state: 'pending' as const })),
        ]);
      }
      if (inputRef.current) inputRef.current.value = '';
    });
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
        onChange={onChange}
        disabled={pending}
      />
      {items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.5rem' }}>
          {items.map((it) => (
            <li
              key={it.name}
              style={{
                fontSize: '0.85rem',
                color: it.state === 'error' ? 'var(--danger)' : 'var(--fg-muted)',
              }}
            >
              {it.state === 'pending' && '⏳ '}
              {it.state === 'ok' && '✓ '}
              {it.state === 'error' && '✗ '}
              {it.name}
              {it.error ? ` — ${it.error}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
