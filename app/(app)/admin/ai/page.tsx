import { FormPageShell } from '@/app/(app)/_components/FormPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AdminAIPage() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.aISuggestionLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      errorReason: true,
      latencyMs: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      acceptedItemIds: true,
    },
  });

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
      header={<PageHeader title="AI suggestions" description="Activity from the last 24 hours." />}
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
    </FormPageShell>
  );
}
