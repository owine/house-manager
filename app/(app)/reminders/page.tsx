import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { ReminderTable } from '@/components/reminders/ReminderTable';
import { listReminders } from '@/lib/reminders/queries';
import { parseListParams } from '@/lib/url-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RemindersPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') sp.set(k, v);
  const params = parseListParams(sp);
  const { reminders, total } = await listReminders(params);

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Reminders ({total})</h1>
        <Link href="/reminders/new">+ Add reminder</Link>
      </header>
      {reminders.length === 0 ? (
        <EmptyState
          message="No reminders yet."
          action={<Link href="/reminders/new">Add your first reminder</Link>}
        />
      ) : (
        <ReminderTable reminders={reminders} />
      )}
    </div>
  );
}
