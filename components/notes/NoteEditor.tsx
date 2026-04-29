'use client';
import { useFormContext, useWatch } from 'react-hook-form';
import { Markdown } from '@/lib/markdown';

export function NoteEditor() {
  const {
    register,
    formState: { errors },
  } = useFormContext();
  const body = useWatch({ name: 'body' }) ?? '';

  return (
    <div style={{ marginBottom: '1rem' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        {/* Textarea pane */}
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <p style={{ fontWeight: 500, marginBottom: '0.25rem', fontSize: '0.85rem' }}>Markdown</p>
          <textarea
            id="body"
            rows={16}
            {...register('body')}
            style={{
              width: '100%',
              padding: '0.4rem 0.5rem',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          {errors.body?.message && (
            <p style={{ fontSize: '0.85rem', color: '#c00', marginTop: '0.25rem' }}>
              {String(errors.body.message)}
            </p>
          )}
        </div>

        {/* Preview pane */}
        <div
          style={{
            flex: '1 1 300px',
            minWidth: 0,
            border: '1px solid #ddd',
            borderRadius: '4px',
            padding: '0.5rem 0.75rem',
            background: '#fafafa',
            overflow: 'auto',
          }}
        >
          <p style={{ fontWeight: 500, marginBottom: '0.25rem', fontSize: '0.85rem' }}>Preview</p>
          {body ? (
            <Markdown>{body}</Markdown>
          ) : (
            <p style={{ color: '#999', fontSize: '0.875rem', fontStyle: 'italic' }}>
              Nothing to preview yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
