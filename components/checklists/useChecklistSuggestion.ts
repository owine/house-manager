'use client';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { ProposedChecklistItem } from '@/lib/ai/schemas';
import { proposeChecklist } from '@/lib/ai/suggest/checklist';

export type ChecklistPreview = {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
};

export function useChecklistSuggestion() {
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<ChecklistPreview | null>(null);

  function run(args: Parameters<typeof proposeChecklist>[0]) {
    startTransition(async () => {
      const r = await proposeChecklist(args);
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to generate checklist');
        return;
      }
      setPreview({
        logId: r.data.logId,
        name: r.data.name,
        description: r.data.description,
        items: r.data.items,
      });
    });
  }

  return {
    pending,
    preview,
    generateSeasonal: () => run({ mode: 'seasonal' }),
    generateFreeform: (freeFormPrompt: string) => run({ mode: 'freeform', freeFormPrompt }),
    reset: () => setPreview(null),
  };
}
