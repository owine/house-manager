import Link from 'next/link';
import { CompleteReminderForm } from '@/components/reminders/CompleteReminderForm';
import { MarkCompleteButton } from '@/components/reminders/MarkCompleteButton';
import type { ReminderTargetSummary } from '@/components/reminders/MarkCompleteDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { QuickStats, upcomingReminders } from '@/lib/dashboard/queries';
import { formatCalendarDate } from '@/lib/format/date';

type Props = {
  stats: QuickStats;
  reminders: Awaited<ReturnType<typeof upcomingReminders>>;
};

export function DueSoonLane({ stats, reminders }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span className="text-2xl font-semibold">{stats.activeItems}</span>
            <span className="text-xs break-words text-muted-foreground">active items</span>
          </div>
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span className="text-2xl font-semibold">{stats.vendors}</span>
            <span className="text-xs break-words text-muted-foreground">vendors</span>
          </div>
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            <span className="text-2xl font-semibold">{stats.serviceThisYear}</span>
            <span
              className="text-xs break-words text-muted-foreground"
              title="Services performed this year"
            >
              services
            </span>
          </div>
        </div>
      </CardContent>
      <Separator />
      <CardHeader>
        <CardTitle>Upcoming reminders</CardTitle>
      </CardHeader>
      <CardContent>
        {reminders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming reminders —{' '}
            <Link href="/reminders/new" className="underline">
              create one
            </Link>
            .
          </p>
        ) : (
          <ul className="space-y-3">
            {reminders.map((r) => (
              <li key={r.id} className="border-b pb-3 last:border-b-0 last:pb-0">
                <div className="flex flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <Link
                    href={`/reminders/${r.id}`}
                    className="min-w-0 max-w-full truncate text-sm sm:flex-1"
                  >
                    {r.title}
                  </Link>
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {formatCalendarDate(r.nextDueOn)}
                  </span>
                </div>
                <div className="mt-1">
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
                      hasItem={r.itemId != null}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
