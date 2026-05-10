import Link from 'next/link';
import { CompleteReminderForm } from '@/components/reminders/CompleteReminderForm';
import { MarkCompleteButton } from '@/components/reminders/MarkCompleteButton';
import type { ReminderTargetSummary } from '@/components/reminders/MarkCompleteDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { upcomingReminders } from '@/lib/dashboard/queries';
import { formatCalendarDate } from '@/lib/format/date';

type Props = {
  reminders: Awaited<ReturnType<typeof upcomingReminders>>;
};

export function UpcomingRemindersCard({ reminders }: Props) {
  return (
    <Card>
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
          <ul className="divide-y">
            {reminders.map((r) => (
              <li key={r.id} className="py-2 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                  <Link href={`/reminders/${r.id}`} className="min-w-0 truncate text-sm sm:flex-1">
                    {r.title}
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatCalendarDate(r.nextDueOn)}
                    </span>
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
