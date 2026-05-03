'use client';
import { Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ProposedChecklistItem } from '@/lib/ai/schemas';
import { proposeChecklist } from '@/lib/ai/suggest/checklist';

type Preview = {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
};

export function SuggestClient() {
  const [prompt, setPrompt] = useState('');
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);

  function go(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (trimmed.length < 3) return;
    startTransition(async () => {
      const r = await proposeChecklist({ mode: 'freeform', freeFormPrompt: trimmed });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to generate');
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

  return (
    <FormPageShell maxWidth="2xl" header={<PageHeader title="Generate suggestion" />}>
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Describe what you want a checklist for — pre-vacation, snowstorm prep, end-of-month
          rentals — and Claude will draft items based on your inventory.
        </p>
        <form onSubmit={go} className="space-y-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Pre-vacation checklist for a 2-week trip"
            maxLength={2000}
            rows={4}
          />
          <Button type="submit" disabled={pending || prompt.trim().length < 3}>
            <Sparkles className="h-4 w-4" />
            {pending ? 'Thinking…' : 'Generate'}
          </Button>
        </form>
        {preview && (
          <section className="space-y-3 border-t pt-6">
            <div>
              <h2 className="text-lg font-semibold">{preview.name}</h2>
              {preview.description && (
                <p className="text-sm text-muted-foreground">{preview.description}</p>
              )}
            </div>
            <SuggestionPreview
              kind="checklist"
              logId={preview.logId}
              name={preview.name}
              description={preview.description}
              items={preview.items}
              onSaved={() => setPreview(null)}
              onDiscard={() => setPreview(null)}
            />
          </section>
        )}
      </div>
    </FormPageShell>
  );
}
