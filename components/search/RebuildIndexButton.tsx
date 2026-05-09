'use client';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { reindexAll } from '@/lib/search/actions';

export function RebuildIndexButton() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
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
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {pending ? 'Enqueueing…' : 'Rebuild search index'}
      </Button>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
