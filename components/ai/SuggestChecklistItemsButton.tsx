'use client';
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { Button } from '@/components/ui/button';
import type { ProposedChecklistItem } from '@/lib/ai/schemas';
import { proposeChecklist } from '@/lib/ai/suggest/checklist';

type Preview = { logId: string; items: ProposedChecklistItem[] };

export function SuggestChecklistItemsButton({
  checklistId,
  checklistName,
}: {
  checklistId: string;
  checklistName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);

  function generate() {
    startTransition(async () => {
      const r = await proposeChecklist({ mode: 'append', forChecklistId: checklistId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to generate suggestions');
        return;
      }
      setPreview({ logId: r.data.logId, items: r.data.items });
    });
  }

  if (preview) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Suggested additions to &ldquo;{checklistName}&rdquo;
          </p>
          <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
            Generate again
          </Button>
        </div>
        <SuggestionPreview
          kind="checklist"
          logId={preview.logId}
          name={checklistName}
          appendToChecklistId={checklistId}
          items={preview.items}
          onSaved={() => {
            setPreview(null);
            router.refresh();
          }}
          onDiscard={() => setPreview(null)}
        />
      </div>
    );
  }

  return (
    <Button variant="outline" onClick={generate} disabled={pending}>
      <Sparkles className="h-4 w-4" />
      {pending ? 'Thinking…' : 'Suggest items'}
    </Button>
  );
}
