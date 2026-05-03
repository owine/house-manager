'use client';
import { Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { Button } from '@/components/ui/button';
import type { ProposedReminder } from '@/lib/ai/schemas';
import { proposeReminders } from '@/lib/ai/suggest/reminders';

type Preview = { logId: string; proposals: ProposedReminder[] };

export function GenerateRemindersButton({ itemId }: { itemId: string }) {
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);

  function generate() {
    startTransition(async () => {
      const r = await proposeReminders({ itemId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to generate suggestions');
        return;
      }
      setPreview({ logId: r.data.logId, proposals: r.data.proposals });
    });
  }

  if (preview) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Suggested reminders for this item — review and save the ones you want.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
            Generate again
          </Button>
        </div>
        <SuggestionPreview
          kind="reminders"
          logId={preview.logId}
          itemId={itemId}
          proposals={preview.proposals}
          onSaved={() => setPreview(null)}
          onDiscard={() => setPreview(null)}
        />
      </div>
    );
  }

  return (
    <Button variant="outline" onClick={generate} disabled={pending}>
      <Sparkles className="h-4 w-4" />
      {pending ? 'Thinking…' : 'Generate reminders'}
    </Button>
  );
}
