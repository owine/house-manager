'use client';
import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { ChecklistPromptDialog } from '@/components/checklists/ChecklistPromptDialog';
import { useChecklistSuggestion } from '@/components/checklists/useChecklistSuggestion';
import { Button } from '@/components/ui/button';

export function ChecklistAiSection() {
  const { pending, preview, generateSeasonal, generateFreeform, reset } = useChecklistSuggestion();
  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <div className="space-y-4 border-t pt-6">
      <p className="text-sm text-muted-foreground">or generate with AI</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setPromptOpen(true)} disabled={pending}>
          <Sparkles className="h-4 w-4" />
          Generate from prompt
        </Button>
        <Button variant="outline" onClick={generateSeasonal} disabled={pending}>
          <Sparkles className="h-4 w-4" />
          {pending ? 'Thinking…' : 'Generate seasonal'}
        </Button>
      </div>
      {pending && !preview && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Generating checklist…
        </div>
      )}
      {preview && (
        <section className="space-y-3">
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
            onSaved={reset}
            onDiscard={reset}
          />
        </section>
      )}
      <ChecklistPromptDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSubmit={generateFreeform}
        pending={pending}
      />
    </div>
  );
}
