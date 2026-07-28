import type { Metadata } from 'next';
import { ChatThread } from '@/components/chat/ChatThread';
import { applyProposal, chatTurn, refreshProposal, rejectProposal } from '@/lib/chat/actions';

export const metadata: Metadata = { title: 'ask' };

// Read ASK_ENABLED via process.env directly (not getEnv()) so the page
// can render even when the rest of the env isn't fully configured. The
// composer is what gets hidden, not the page — a partially-configured
// deployment must still render.
const ASK_ENABLED = process.env.ASK_ENABLED === 'true' || process.env.ASK_ENABLED === '1';

export default function AskPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-medium tracking-tight">ask</h1>
        <p className="text-sm text-muted-foreground">
          Dump unstructured thoughts about your home. Proposed record changes show up as cards below
          — review and accept them one by one.
        </p>
      </header>
      {!ASK_ENABLED && (
        <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          The Ask feature is not enabled on this deployment. Set <code>ASK_ENABLED=true</code> and{' '}
          <code>VOYAGE_API_KEY</code> to turn it on.
        </div>
      )}
      <ChatThread
        askEnabled={ASK_ENABLED}
        chatTurn={chatTurn}
        applyProposal={applyProposal}
        rejectProposal={rejectProposal}
        refreshProposal={refreshProposal}
      />
    </div>
  );
}
