import Link from 'next/link';
import { GenerateRemindersButton } from '@/components/ai/GenerateRemindersButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import type { getItem } from '@/lib/items/queries';

type Item = NonNullable<Awaited<ReturnType<typeof getItem>>>;

type Props = { item: Item };

export function RemindersTab({ item }: Props) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b pb-3">
        <CardTitle>Reminders</CardTitle>
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/reminders/new?itemId=${item.id}`} />}
        >
          + Add reminder
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        <div className="mb-4">
          <GenerateRemindersButton itemId={item.id} />
        </div>
        {item.reminders.length === 0 ? (
          <p className="text-sm text-muted-foreground">no reminders yet.</p>
        ) : (
          <ul className="divide-y">
            {item.reminders.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <Link
                  href={`/reminders/${r.id}`}
                  className="text-sm underline-offset-4 hover:underline"
                >
                  {r.title}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {formatCalendarDate(r.nextDueOn)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
