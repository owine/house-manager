'use client';

import { Loader2, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ChatTurnData, ChatTurnProposal } from '@/lib/chat/actions';
import type { ActionResult } from '@/lib/result';
import { ProposalCard } from './ProposalCard';

export type ThreadEntry =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; proposals: ChatTurnProposal[] };

type ChatTurnFn = (input: unknown) => Promise<ActionResult<ChatTurnData>>;
type ApplyOrRejectFn = (proposalId: unknown) => Promise<ActionResult<{ id: string }>>;
type RefreshFn = (proposalId: unknown) => Promise<ActionResult<{ proposal: ChatTurnProposal }>>;

export type ChatThreadProps = {
  /** Gates only the composer — existing sessions/proposals must still render and apply. */
  askEnabled: boolean;
  initialSessionId?: string;
  initialThread?: ThreadEntry[];
  chatTurn: ChatTurnFn;
  applyProposal: ApplyOrRejectFn;
  rejectProposal: ApplyOrRejectFn;
  refreshProposal: RefreshFn;
};

export function ChatThread({
  askEnabled,
  initialSessionId,
  initialThread,
  chatTurn,
  applyProposal,
  rejectProposal,
  refreshProposal,
}: ChatThreadProps) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [thread, setThread] = useState<ThreadEntry[]>(initialThread ?? []);
  const [draft, setDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const threadEndRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive re-run, not body
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread.length, pending]);

  function submit(value?: string) {
    const text = (value ?? draft).trim();
    if (text.length < 3) {
      toast.error('Type a message first.');
      return;
    }

    const userEntry: ThreadEntry = { id: `local-${Date.now()}`, role: 'user', content: text };
    setThread((prev) => [...prev, userEntry]);
    setDraft('');

    startTransition(async () => {
      // Prior turns are replayed server-side from the session (see
      // lib/chat/actions.ts persistTurn) once a sessionId exists — only the
      // latest user message is ever sent.
      const result = await chatTurn({
        sessionId,
        messages: [{ role: 'user', content: text }],
      });
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not process your message.');
        setThread((prev) => prev.filter((e) => e.id !== userEntry.id));
        setDraft(text);
        return;
      }

      if (!sessionId) {
        setSessionId(result.data.sessionId);
        router.replace(`/ask/${result.data.sessionId}`);
      }

      setThread((prev) => [
        ...prev,
        {
          id: result.data.messageId,
          role: 'assistant',
          content: result.data.reply,
          proposals: result.data.proposals,
        },
      ]);
    });
  }

  const isEmpty = thread.length === 0;

  return (
    <div className="space-y-6">
      {!isEmpty && (
        <div className="space-y-4">
          {thread.map((entry) =>
            entry.role === 'user' ? (
              <div key={entry.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
                  {entry.content}
                </div>
              </div>
            ) : (
              <div key={entry.id} className="space-y-3">
                <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm">
                  {entry.content}
                </div>
                {entry.proposals.length > 0 && (
                  <div className="flex flex-wrap gap-3">
                    {entry.proposals.map((proposal) => (
                      <ProposalCard
                        key={proposal.id}
                        proposal={proposal}
                        applyProposal={applyProposal}
                        rejectProposal={rejectProposal}
                        refreshProposal={refreshProposal}
                      />
                    ))}
                  </div>
                )}
              </div>
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

      {askEnabled && (
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
              isEmpty ? 'Dump a thought about your home — a repair, a note, a date…' : 'Keep going…'
            }
            className="min-h-[5rem]"
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center justify-between">
            {!isEmpty && (
              <Button variant="ghost" size="sm" render={<Link href="/ask" />}>
                New conversation
              </Button>
            )}
            <Button type="submit" disabled={pending || draft.trim().length < 3} className="ml-auto">
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {pending ? 'Thinking…' : 'Send'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
