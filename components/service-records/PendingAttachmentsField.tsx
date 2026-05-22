'use client';
import { Link2, Paperclip, X } from 'lucide-react';
import type React from 'react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type StagedAttachments = {
  files: File[];
  links: { url: string; label?: string }[];
};

type Props = {
  onChange: (staged: StagedAttachments) => void;
};

const MAX_BYTES = 25_000_000;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type StagedFile = { key: string; file: File };
type StagedLink = { key: string; url: string; label?: string };

export function PendingAttachmentsField({ onChange }: Props) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [links, setLinks] = useState<StagedLink[]>([]);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const filesId = useId();
  const urlId = useId();
  const labelId = useId();

  function nextKey() {
    seq.current += 1;
    return `staged-${seq.current}`;
  }

  function emit(nextFiles: StagedFile[], nextLinks: StagedLink[]) {
    onChange({
      files: nextFiles.map((f) => f.file),
      links: nextLinks.map(({ url: u, label: l }) => (l ? { url: u, label: l } : { url: u })),
    });
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    const selected = Array.from(e.target.files ?? []);
    if (selected.length === 0) return;
    const accepted: StagedFile[] = [];
    for (const f of selected) {
      if (!ALLOWED.includes(f.type)) {
        setFileError('Unsupported file type');
        continue;
      }
      if (f.size > MAX_BYTES) {
        setFileError('File too large (max 25 MB)');
        continue;
      }
      accepted.push({ key: nextKey(), file: f });
    }
    if (accepted.length > 0) {
      const next = [...files, ...accepted];
      setFiles(next);
      emit(next, links);
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  function onAddLink() {
    setLinkError(null);
    if (!/^https?:\/\//i.test(url)) {
      setLinkError('Link must start with http:// or https://');
      return;
    }
    const next = [...links, { key: nextKey(), url, ...(label ? { label } : {}) }];
    setLinks(next);
    setUrl('');
    setLabel('');
    emit(files, next);
  }

  function removeLink(key: string) {
    const next = links.filter((l) => l.key !== key);
    setLinks(next);
    emit(files, next);
  }

  function removeFile(key: string) {
    const next = files.filter((f) => f.key !== key);
    setFiles(next);
    emit(next, links);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={filesId}>Add files</Label>
        {/* No `accept` attribute: the browser hint only filters the picker
            and is trivially bypassed (the user can choose "All files"), so
            it gives a false sense of safety. We validate MIME + size in JS
            below — the authoritative gate the live uploader's server action
            also enforces. */}
        <Input ref={inputRef} id={filesId} type="file" multiple onChange={onFileChange} />
        <p className="text-xs text-muted-foreground">
          PDFs and images (JPG, PNG, WebP, HEIC), max 25 MB
        </p>
        {fileError && (
          <p className="text-sm text-destructive" role="alert">
            {fileError}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2 border-t pt-3">
        <div className="flex flex-[2_1_320px] flex-col gap-1.5">
          <Label htmlFor={urlId} className="text-xs">
            Link URL
          </Label>
          <Input
            id={urlId}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://drive.proton.me/..."
          />
        </div>
        <div className="flex flex-1 basis-[200px] flex-col gap-1.5">
          <Label htmlFor={labelId} className="text-xs">
            Link label
          </Label>
          <Input
            id={labelId}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
          />
        </div>
        <Button type="button" variant="outline" onClick={onAddLink} disabled={url === ''}>
          <Link2 className="h-4 w-4" />
          Add link
        </Button>
        {linkError && (
          <p className="basis-full text-sm text-destructive" role="alert">
            {linkError}
          </p>
        )}
      </div>

      {(links.length > 0 || files.length > 0) && (
        <ul className="space-y-1 text-sm">
          {links.map((link) => (
            <li key={link.key} className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{link.label ?? link.url}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Remove ${link.label ?? link.url}`}
                onClick={() => removeLink(link.key)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
          {files.map(({ key, file }) => (
            <li key={key} className="flex items-center gap-2">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{file.name}</span>
              <span className="text-xs text-muted-foreground">({formatSize(file.size)})</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Remove ${file.name}`}
                onClick={() => removeFile(key)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
