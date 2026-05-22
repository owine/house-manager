'use client';
import { useFormContext, useWatch } from 'react-hook-form';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/lib/markdown';

export function NoteEditor() {
  const {
    register,
    formState: { errors },
  } = useFormContext();
  const body = useWatch({ name: 'body' }) ?? '';
  const bodyError = errors.body?.message as string | undefined;

  return (
    <div className="flex flex-wrap gap-4">
      {/* Markdown pane */}
      <div className="flex flex-1 basis-72 min-w-0 flex-col gap-1.5">
        <p className="text-sm font-medium leading-none" id="body-label">
          Body (markdown)
        </p>
        <Textarea
          id="body"
          aria-labelledby="body-label"
          rows={16}
          className="resize-y font-mono text-sm"
          {...register('body')}
        />
        {bodyError && <p className="text-sm font-medium text-destructive">{bodyError}</p>}
      </div>

      {/* Preview pane */}
      <div className="flex-1 basis-72 min-w-0 rounded-lg border border-input bg-muted/40 px-3 py-2 overflow-auto">
        <p className="mb-2 text-sm font-medium">Preview</p>
        {body ? (
          <Markdown>{body}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground italic">Nothing to preview yet.</p>
        )}
      </div>
    </div>
  );
}
