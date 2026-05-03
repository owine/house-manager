'use client';
import { Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { seasonForDate } from '@/lib/ai/prompts';
import type { ProposedChecklistItem } from '@/lib/ai/schemas';
import { proposeChecklist } from '@/lib/ai/suggest/checklist';

type Preview = {
  logId: string;
  name: string;
  description?: string;
  items: ProposedChecklistItem[];
};

export function SeasonalChecklistCard() {
  const season = seasonForDate(new Date());
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);

  function generate() {
    startTransition(async () => {
      const r = await proposeChecklist({ mode: 'seasonal', season });
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seasonal checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!preview ? (
          <>
            <p className="text-sm text-muted-foreground">
              Generate a {season} maintenance checklist tailored to your inventory.
            </p>
            <Button variant="outline" onClick={generate} disabled={pending}>
              <Sparkles className="h-4 w-4" />
              {pending ? 'Thinking…' : `Generate ${season} checklist`}
            </Button>
          </>
        ) : (
          <div className="space-y-3">
            <div>
              <h3 className="font-semibold">{preview.name}</h3>
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
