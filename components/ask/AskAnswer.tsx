import type { AskAnswer as AskAnswerType } from '@/lib/ai/schemas';
import { Markdown } from '@/lib/markdown';
import { CitationChip } from './CitationChip';

export function AskAnswer({ answer }: { answer: AskAnswerType }) {
  return (
    <div className="space-y-4">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <Markdown>{answer.answer}</Markdown>
      </div>
      {answer.citations.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Sources</p>
          <div className="flex flex-wrap gap-1.5">
            {answer.citations.map((c) => (
              <CitationChip key={`${c.entityType}:${c.entityId}`} citation={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
