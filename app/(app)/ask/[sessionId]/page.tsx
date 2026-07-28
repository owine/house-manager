import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChatThread, type ThreadEntry } from '@/components/chat/ChatThread';
import { toChatTurnProposal } from '@/components/chat/proposal-mapping';
import { auth } from '@/lib/auth';
import { applyProposal, chatTurn, refreshProposal, rejectProposal } from '@/lib/chat/actions';
import { getChatSession } from '@/lib/chat/queries';

// Same graceful-fallback reasoning as app/(app)/ask/page.tsx — the composer
// (not the page, not an already-captured proposal) is what the flag gates.
const ASK_ENABLED = process.env.ASK_ENABLED === 'true' || process.env.ASK_ENABLED === '1';

type Params = Promise<{ sessionId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { sessionId } = await params;
  const session = await auth();
  if (!session?.user?.id) return { title: 'ask' };
  const chatSession = await getChatSession(sessionId, session.user.id);
  return { title: chatSession?.title ?? 'ask' };
}

export default async function AskSessionPage({ params }: { params: Params }) {
  const { sessionId } = await params;

  const session = await auth();
  if (!session?.user?.id) return notFound();

  // null covers both "does not exist" and "belongs to another user" —
  // deliberately not distinguished, so this is a single notFound() branch.
  const chatSession = await getChatSession(sessionId, session.user.id);
  if (!chatSession) return notFound();

  const initialThread: ThreadEntry[] = chatSession.messages.map((m) =>
    m.role === 'USER'
      ? { id: m.id, role: 'user' as const, content: m.content }
      : {
          id: m.id,
          role: 'assistant' as const,
          content: m.content,
          proposals: m.proposals.map(toChatTurnProposal),
        },
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-medium tracking-tight">{chatSession.title}</h1>
        <p className="text-sm text-muted-foreground">
          Dump unstructured thoughts about your home. Proposed record changes show up as cards below
          — review and accept them one by one.
        </p>
      </header>
      {!ASK_ENABLED && (
        <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          The Ask feature is not enabled on this deployment. Existing proposals can still be
          reviewed and applied below, but new messages are disabled. Set{' '}
          <code>ASK_ENABLED=true</code> and <code>VOYAGE_API_KEY</code> to turn it back on.
        </div>
      )}
      <ChatThread
        askEnabled={ASK_ENABLED}
        initialSessionId={chatSession.id}
        initialThread={initialThread}
        chatTurn={chatTurn}
        applyProposal={applyProposal}
        rejectProposal={rejectProposal}
        refreshProposal={refreshProposal}
      />
    </div>
  );
}
