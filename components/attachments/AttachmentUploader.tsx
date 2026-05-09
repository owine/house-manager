'use client';
import { CheckCircle2, CircleAlert, Loader2, Upload } from 'lucide-react';
import type React from 'react';
import { useId, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { uploadAttachment } from '@/lib/attachments/actions';
import type { ParentType } from '@/lib/attachments/schema';
import { AttachmentLinkForm } from './AttachmentLinkForm';

type Status = { name: string; state: 'pending' | 'ok' | 'error'; error?: string };

type Props = {
  parentType: ParentType;
  parentId: string;
};

export function AttachmentUploader({ parentType, parentId }: Props) {
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<Status[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

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
    <div className="mt-3 space-y-3">
      {/* Native input is visually hidden but still focusable + clickable via
          the styled Button rendered as a <label htmlFor>. This keeps screen
          readers happy and gives us the standard Button styling without
          fighting browser file-input defaults. */}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
        onChange={onChange}
        disabled={pending}
        className="sr-only"
      />
      <Button
        variant="outline"
        disabled={pending}
        render={
          <label htmlFor={inputId} className={pending ? 'cursor-not-allowed' : 'cursor-pointer'}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {pending ? 'Uploading…' : 'Choose files'}
          </label>
        }
      />
      <p className="text-xs text-muted-foreground">PDFs and images (JPG, PNG, WebP, HEIC)</p>

      {items.length > 0 && (
        <ul className="space-y-1 text-sm">
          {items.map((it) => (
            <li key={it.name} className="flex items-center gap-2">
              {it.state === 'pending' && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
              {it.state === 'ok' && (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              )}
              {it.state === 'error' && (
                <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
              )}
              <span className={it.state === 'error' ? 'text-destructive' : ''}>{it.name}</span>
              {it.error && <span className="text-xs text-muted-foreground">— {it.error}</span>}
            </li>
          ))}
        </ul>
      )}
      <AttachmentLinkForm parentType={parentType} parentId={parentId} />
    </div>
  );
}
