import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { CompleteReminderForm } from '@/components/reminders/CompleteReminderForm';
import { MarkCompleteButton } from '@/components/reminders/MarkCompleteButton';
import type { ReminderTargetSummary } from '@/components/reminders/MarkCompleteDialog';
import { ReminderOverflowMenu } from '@/components/reminders/ReminderOverflowMenu';
import { ReminderStatusBadge } from '@/components/reminders/ReminderStatusBadge';
import { TargetsChips } from '@/components/targets/TargetsChips';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import { Markdown } from '@/lib/markdown';
import { describeRecurrence } from '@/lib/reminders/describe';
import { getReminder } from '@/lib/reminders/queries';
import { previewOccurrences } from '@/lib/reminders/recurrence';
import { parseRecurrence } from '@/lib/reminders/schema';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const r = await getReminder(id);
  return { title: r?.title ?? 'Not found' };
}

export default async function ReminderDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const r = await getReminder(id);
  if (!r) notFound();

  const recurrence = parseRecurrence(r.recurrence);
  const occurrences = r.nextDueOn
    ? [r.nextDueOn, ...previewOccurrences(recurrence, r.nextDueOn, 4)]
    : [];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={r.title} actions={<ReminderOverflowMenu reminderId={r.id} />} />

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        {r.nextDueOn && <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />}
        <span className="text-muted-foreground">{describeRecurrence(recurrence)}</span>
        {r.targets.some((t) => t.item !== null || t.system !== null) && (
          <span className="flex items-center gap-2 text-muted-foreground">
            for <TargetsChips targets={r.targets} />
          </span>
        )}
      </div>

      {r.description && <Markdown>{r.description}</Markdown>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Upcoming</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {occurrences.map((d) => (
                <li key={d.toISOString()}>{formatCalendarDate(d)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">History ({r.completions.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {r.completions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not completed yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {r.completions.map((c) => (
                  <li key={c.id}>
                    {formatCalendarDate(c.completedOn)} — completed by {c.completedBy.name}
                    {c.notes && <span className="text-muted-foreground">: {c.notes}</span>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        {r.targets.length >= 2 ? (
          <MarkCompleteButton
            reminderId={r.id}
            reminderTitle={r.title}
            targets={r.targets.map<ReminderTargetSummary>((t) => ({
              id: t.id,
              label: t.item?.name ?? t.system?.name ?? '(unnamed target)',
              kind: t.systemId ? 'system' : 'item',
            }))}
          />
        ) : (
          <CompleteReminderForm
            reminderId={r.id}
            autoCreateServiceRecord={r.autoCreateServiceRecord}
            hasItem={r.targets.some((t) => t.itemId !== null)}
          />
        )}
      </div>
    </div>
  );
}
