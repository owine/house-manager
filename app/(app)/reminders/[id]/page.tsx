import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompleteReminderForm } from '@/components/reminders/CompleteReminderForm';
import { ReminderStatusBadge } from '@/components/reminders/ReminderStatusBadge';
import { Markdown } from '@/lib/markdown';
import { getReminder } from '@/lib/reminders/queries';
import { previewOccurrences } from '@/lib/reminders/recurrence';
import type { Recurrence } from '@/lib/reminders/schema';

type Params = Promise<{ id: string }>;

export default async function ReminderDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const r = await getReminder(id);
  if (!r) notFound();

  const recurrence = r.recurrence as unknown as Recurrence;
  const upcoming = previewOccurrences(recurrence, r.nextDueOn, 4);
  const occurrences = [r.nextDueOn, ...upcoming];

  return (
    <div>
      <header>
        <h1 style={{ margin: 0 }}>{r.title}</h1>
        <div
          style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.25rem' }}
        >
          <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />
          {r.item && (
            <span style={{ fontSize: '0.85rem' }}>
              for <Link href={`/items/${r.item.id}`}>{r.item.name}</Link>
            </span>
          )}
        </div>
      </header>
      {r.description && <Markdown>{r.description}</Markdown>}

      <h2 style={{ fontSize: '1rem', marginTop: '1rem' }}>Upcoming</h2>
      <ul>
        {occurrences.map((d) => (
          <li key={d.toISOString()}>{d.toISOString().slice(0, 10)}</li>
        ))}
      </ul>

      <h2 style={{ fontSize: '1rem', marginTop: '1rem' }}>History ({r.completions.length})</h2>
      {r.completions.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>Not completed yet.</p>
      ) : (
        <ul>
          {r.completions.map((c) => (
            <li key={c.id}>
              {c.completedOn.toISOString().slice(0, 10)} — completed by {c.completedBy.name}
              {c.notes && <span style={{ color: 'var(--fg-muted)' }}>: {c.notes}</span>}
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
        <CompleteReminderForm
          reminderId={r.id}
          autoCreateServiceRecord={r.autoCreateServiceRecord}
          hasItem={r.itemId != null}
        />
        <Link href={`/reminders/${r.id}/edit`}>Edit</Link>
      </div>
    </div>
  );
}
