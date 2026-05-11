'use client';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { rebuildAllEmbeddings } from '@/lib/embedding/admin-actions';

export function RebuildEmbeddingsButton() {
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
            const r = await rebuildAllEmbeddings();
            setStatus(
              r.ok
                ? 'Rebuild started — embeddings refresh asynchronously over the next few minutes.'
                : (r.formError ?? 'Failed to start rebuild.'),
            );
          })
        }
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {pending ? 'Enqueueing…' : 'Rebuild all embeddings'}
      </Button>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
