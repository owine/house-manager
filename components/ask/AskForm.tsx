'use client';

import { Loader2, RotateCcw, Send } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
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

// A single turn in the rendered thread. User turns are bare strings; assistant
// turns carry the full `EnrichedAskAnswer` so citations can render.
type ThreadEntry =
  | { role: 'user'; content: string }
  | { role: 'assistant'; answer: EnrichedAskAnswer };

// 20-turn cap matches the server-side schema. We disable input once reached.
const MAX_TURNS = 20;

export function AskForm() {
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [pending, startTransition] = useTransition();
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest turn whenever the thread grows or pending flips.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive re-run, not body
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread.length, pending]);

  function submit(value?: string) {
    const q = (value ?? draft).trim();
    if (q.length < 3) {
      toast.error('Type a question first.');
      return;
    }
    if (thread.length >= MAX_TURNS) {
      toast.error('Thread is full. Start a new conversation.');
      return;
    }

    // Optimistically append the user turn so the input clears immediately.
    const nextThread: ThreadEntry[] = [...thread, { role: 'user', content: q }];
    setThread(nextThread);
    setDraft('');

    startTransition(async () => {
      const entityTypes = scope === 'all' ? undefined : [scope as Exclude<typeof scope, 'all'>];
      // Server expects the full thread as { role, content } pairs. For
      // assistant turns we forward the prose only — citations don't help the
      // model and they'd just inflate the prompt.
      const apiMessages = nextThread.map((entry) =>
        entry.role === 'user'
          ? { role: 'user' as const, content: entry.content }
          : { role: 'assistant' as const, content: entry.answer.answer },
      );
      const result = await askQuestion({ messages: apiMessages, entityTypes });
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not answer your question.');
        // Roll the user turn back so they can edit + retry without re-typing.
        setThread(thread);
        setDraft(q);
        return;
      }
      setThread((prev) => [...prev, { role: 'assistant', answer: result.data.answer }]);
    });
  }

  function reset() {
    setThread([]);
    setDraft('');
  }

  const isEmpty = thread.length === 0;
  const atCap = thread.length >= MAX_TURNS;

  return (
    <div className="space-y-6">
      {!isEmpty && (
        <div className="space-y-4">
          {thread.map((entry, i) =>
            entry.role === 'user' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: thread order is stable
              <div key={`u-${i}`} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
                  {entry.content}
                </div>
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: thread order is stable
              <AskAnswer key={`a-${i}`} answer={entry.answer} />
            ),
          )}
          {pending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Thinking…
            </div>
          )}
          <div ref={threadEndRef} />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            isEmpty ? 'Ask anything about your home and household records…' : 'Ask a follow-up…'
          }
          className="min-h-[5rem]"
          disabled={pending || atCap}
          onKeyDown={(e) => {
            // Enter to submit, Shift+Enter for newline — mirrors common chat UX.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Scope:</span>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v ?? 'all')}
              disabled={pending || !isEmpty}
            >
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
            {!isEmpty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={reset}
                disabled={pending}
                className="text-muted-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                New conversation
              </Button>
            )}
          </div>
          <Button type="submit" disabled={pending || draft.trim().length < 3 || atCap}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {pending ? 'Thinking…' : isEmpty ? 'Ask' : 'Send'}
          </Button>
        </div>
        {atCap && (
          <p className="text-xs text-muted-foreground">
            This conversation has reached the {MAX_TURNS}-turn limit. Start a new conversation to
            continue.
          </p>
        )}
      </form>

      {isEmpty && !pending && (
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
    </div>
  );
}
