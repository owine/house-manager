import type { Metadata } from 'next';
import { askQuestion } from '@/lib/ask/actions';

export const metadata: Metadata = { title: 'Ask' };

// Phase E placeholder. Wires the server action to the route so knip sees
// a consumer; Phase F replaces this with the real form + answer renderer
// + citation chips.
//
// Reading from process.env directly to avoid Zod-validating the optional
// VOYAGE_API_KEY when the feature is disabled.
const ASK_ENABLED = process.env.ASK_ENABLED === 'true' || process.env.ASK_ENABLED === '1';

export default function AskPage() {
  if (!ASK_ENABLED) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
        <h1 className="text-2xl font-semibold">Ask</h1>
        <p className="text-sm text-muted-foreground">
          The Ask feature is not enabled on this deployment.
        </p>
      </div>
    );
  }
  // Keep the import bound so the bundle resolves the action; Phase F wires
  // the real client form that invokes it.
  void askQuestion;
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">Ask</h1>
      <p className="text-sm text-muted-foreground">Coming soon — full UI lands in Phase F.</p>
    </div>
  );
}
