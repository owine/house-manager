'use client';
import { Sparkles } from 'lucide-react';
import { SuggestionPreview } from '@/app/(app)/_components/SuggestionPreview';
import { useChecklistSuggestion } from '@/components/checklists/useChecklistSuggestion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function SeasonalChecklistCard() {
  const { pending, preview, season, generateSeasonal, reset } = useChecklistSuggestion();

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
            <Button variant="outline" onClick={generateSeasonal} disabled={pending}>
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
              onSaved={reset}
              onDiscard={reset}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
