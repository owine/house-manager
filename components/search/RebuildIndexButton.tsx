'use client';
import { useState, useTransition } from 'react';
import { reindexAll } from '@/lib/search/actions';

export function RebuildIndexButton() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setStatus(null);
            const r = await reindexAll();
            setStatus(
              r.ok
                ? 'Rebuild started — refresh the search results in a few seconds.'
                : (r.formError ?? 'Failed'),
            );
          })
        }
      >
        {pending ? 'Enqueueing…' : 'Rebuild search index'}
      </button>
      {status && (
        <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
          {status}
        </p>
      )}
    </div>
  );
}
