import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LocalDate } from '@/components/ui/LocalDate';
import type { ExtractionView } from '@/lib/incoming-email/queries';
import { Markdown } from '@/lib/markdown';

type Props = {
  extraction: ExtractionView;
};

function formatCurrency(n: number | null): string {
  if (n === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

/**
 * Read-only view of the AI-extracted invoice/ticket fields. The user can't
 * edit these here — the canonical place to edit is on the resulting
 * ServiceRecord after clicking Create. If the AI got it wrong, the user can
 * re-run the AI via Reclassify (e.g. after a vendor sends a corrected invoice
 * into the same Message-ID, or after we tune the prompt). Empty state when
 * none of the fields extracted: still show the card with a single "no fields
 * extracted" line, so the user knows extraction was attempted.
 */
export function ExtractedFieldsCard({ extraction }: Props) {
  const hasAny =
    extraction.summary !== null ||
    extraction.cost !== null ||
    extraction.performedOn !== null ||
    extraction.scope !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            Extracted from email
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!hasAny && extraction.extractedAt === null && (
          <p className="italic text-muted-foreground">
            Not yet extracted — should appear shortly after the email is classified.
          </p>
        )}
        {!hasAny && extraction.extractedAt !== null && (
          <p className="italic text-muted-foreground">
            Extraction returned no usable fields for this email. Use Reclassify to retry (when
            available), or fill in the service record manually after creating it.
          </p>
        )}

        {extraction.summary !== null && (
          <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Summary</span>
            <span className="font-medium">{extraction.summary}</span>
          </div>
        )}
        {extraction.cost !== null && (
          <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Cost</span>
            <span className="font-medium">{formatCurrency(extraction.cost)}</span>
          </div>
        )}
        {extraction.performedOn !== null && (
          <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Service date</span>
            <span className="font-medium">
              <LocalDate iso={extraction.performedOn.toISOString()} />
            </span>
          </div>
        )}
        {extraction.scope !== null && (
          <div>
            <p className="mb-1 text-muted-foreground">Scope of work</p>
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <Markdown>{extraction.scope}</Markdown>
            </div>
          </div>
        )}

        {extraction.extractedAt !== null && (
          <p className="pt-2 text-xs text-muted-foreground">
            Extracted <LocalDate iso={extraction.extractedAt.toISOString()} />. These values
            pre-fill the service record on Create; edit there if anything looks off.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
