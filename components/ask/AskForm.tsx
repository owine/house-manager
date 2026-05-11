'use client';

import { Loader2, Send } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { askQuestion, type EnrichedAskAnswer } from '@/lib/ask/actions';
import { AskAnswer } from './AskAnswer';

const EXAMPLES = [
  'When did I last service the HVAC?',
  "What's the warranty status on my dishwasher?",
  'What did I pay for snow removal this winter?',
  'Show notes about the basement sump pump.',
];

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All content' },
  { value: 'ITEM', label: 'Items' },
  { value: 'NOTE', label: 'Notes' },
  { value: 'SERVICE_RECORD', label: 'Service history' },
  { value: 'WARRANTY', label: 'Warranties' },
  { value: 'CHECKLIST_ITEM', label: 'Checklists' },
  { value: 'ATTACHMENT', label: 'Attachments' },
] as const;

export function AskForm() {
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [answer, setAnswer] = useState<EnrichedAskAnswer | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(value?: string) {
    const q = (value ?? question).trim();
    if (q.length < 3) {
      toast.error('Type a question first.');
      return;
    }
    setQuestion(q);
    setAnswer(null);
    startTransition(async () => {
      const entityTypes = scope === 'all' ? undefined : [scope as Exclude<typeof scope, 'all'>];
      const result = await askQuestion({ question: q, entityTypes });
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not answer your question.');
        return;
      }
      setAnswer(result.data.answer);
    });
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask anything about your home and household records…"
          className="min-h-[5rem]"
          disabled={pending}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Scope:</span>
            <Select value={scope} onValueChange={(v) => setScope(v ?? 'all')} disabled={pending}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={pending || question.trim().length < 3}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {pending ? 'Thinking…' : 'Ask'}
          </Button>
        </div>
      </form>

      {!answer && !pending && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Try one of these:</p>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => submit(ex)}
                className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {answer && <AskAnswer answer={answer} />}
    </div>
  );
}
