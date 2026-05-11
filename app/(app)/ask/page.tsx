import type { Metadata } from 'next';
import { AskForm } from '@/components/ask/AskForm';

export const metadata: Metadata = { title: 'Ask' };

// Read ASK_ENABLED via process.env directly (not getEnv()) so the page
// can render even when the rest of the env isn't fully configured. The
// disabled view is a graceful fallback for self-hosters who haven't
// turned on the feature.
const ASK_ENABLED = process.env.ASK_ENABLED === 'true' || process.env.ASK_ENABLED === '1';

export default function AskPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Ask</h1>
        <p className="text-sm text-muted-foreground">
          Natural-language Q&amp;A across your items, notes, service records, warranties,
          checklists, and attachment text.
        </p>
      </header>
      {ASK_ENABLED ? (
        <AskForm />
      ) : (
        <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          The Ask feature is not enabled on this deployment. Set <code>ASK_ENABLED=true</code> and{' '}
          <code>VOYAGE_API_KEY</code> to turn it on.
        </div>
      )}
    </div>
  );
}
