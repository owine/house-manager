'use client';
import { Link2, Loader2 } from 'lucide-react';
import type React from 'react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
      <div className="flex flex-1 basis-[200px] flex-col gap-1.5">
        <Label htmlFor="attachment-link-label" className="text-xs">
          Label (optional)
        </Label>
        <Input
          id="attachment-link-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={pending}
        />
      </div>
      <div className="flex flex-[2_1_320px] flex-col gap-1.5">
        <Label htmlFor="attachment-link-url" className="text-xs">
          URL (https or http)
        </Label>
        <Input
          id="attachment-link-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder="https://drive.proton.me/..."
          disabled={pending}
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending || url === ''}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
        {pending ? 'Adding…' : 'Add link'}
      </Button>
      {error && <p className="basis-full text-sm text-destructive">{error}</p>}
    </form>
  );
}
