import type { Metadata } from 'next';
import { FormPageShell } from '@/app/(app)/_components/FormPageShell';

export const metadata: Metadata = { title: 'ai suggestions' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { RebuildEmbeddingsButton } from '@/components/admin/RebuildEmbeddingsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AdminAIPage() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.aISuggestionLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      kind: true,
      errorReason: true,
      latencyMs: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      acceptedItemIds: true,
      citationCount: true,
    },
  });

  // Per-kind rollup so the Plan 4c Ask call volume is visible alongside
  // Plan 4b's suggester counts.
  const perKind = new Map<string, { total: number; failed: number; citations: number }>();
  for (const r of rows) {
    const entry = perKind.get(r.kind) ?? { total: 0, failed: 0, citations: 0 };
    entry.total += 1;
    if (r.errorReason) entry.failed += 1;
    if (r.kind === 'ask' && r.citationCount) entry.citations += r.citationCount;
    perKind.set(r.kind, entry);
  }

  // Total embeddings stored — useful when validating the backfill button
  // and when monitoring growth over time.
  const embeddingCount = await prisma.embedding.count();

  const total = rows.length;
  const failed = rows.filter((r) => r.errorReason).length;
  const succeeded = total - failed;
  const accepted = rows.filter(
    (r) => Array.isArray(r.acceptedItemIds) && (r.acceptedItemIds as unknown[]).length > 0,
  ).length;
  const acceptRate = succeeded ? Math.round((accepted / succeeded) * 100) : 0;
  const successfulWithLatency = rows.filter((r) => !r.errorReason && r.latencyMs);
  const avgLatency = successfulWithLatency.length
    ? Math.round(
        successfulWithLatency.reduce((s, r) => s + (r.latencyMs ?? 0), 0) /
          successfulWithLatency.length,
      )
    : 0;
  const totalIn = rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const totalCache = rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);

  const stats: { label: string; value: string }[] = [
    { label: 'Total calls', value: String(total) },
    {
      label: 'Failures',
      value: `${failed}${total ? ` (${Math.round((failed / total) * 100)}%)` : ''}`,
    },
    { label: 'Accept rate', value: `${acceptRate}%` },
    { label: 'Avg latency', value: `${avgLatency} ms` },
    { label: 'Input tokens', value: totalIn.toLocaleString() },
    { label: 'Output tokens', value: totalOut.toLocaleString() },
    { label: 'Cache reads', value: totalCache.toLocaleString() },
  ];

  return (
    <FormPageShell
      maxWidth="3xl"
      header={<PageHeader title="ai suggestions" description="Activity from the last 24 hours." />}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader>
              <CardTitle className="text-sm font-normal text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By kind</CardTitle>
        </CardHeader>
        <CardContent>
          {perKind.size === 0 ? (
            <p className="text-sm text-muted-foreground">No AI calls in the last 24 hours.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {[...perKind.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([kind, agg]) => (
                  <li key={kind} className="flex justify-between gap-4">
                    <span className="font-medium">{kind}</span>
                    <span className="text-muted-foreground">
                      {agg.total} total · {agg.failed} failed
                      {kind === 'ask' && agg.total > 0 ? ` · ${agg.citations} citations` : ''}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Embedding index</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {embeddingCount.toLocaleString()} chunks stored across all entity types. The worker
            keeps this in sync as entities change; use the rebuild button if you've changed the
            canonical-text builders or want to re-embed after a model upgrade.
          </p>
          <RebuildEmbeddingsButton />
        </CardContent>
      </Card>
    </FormPageShell>
  );
}
