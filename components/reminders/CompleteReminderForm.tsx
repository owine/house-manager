'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { completeReminder } from '@/lib/reminders/actions';

type Props = {
  reminderId: string;
  autoCreateServiceRecord: boolean;
  hasItem: boolean;
};

export function CompleteReminderForm({ reminderId, autoCreateServiceRecord, hasItem }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState('');
  const [cost, setCost] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ padding: '0.5rem 1rem' }}>
        Mark complete
      </button>
    );
  }

  const showServiceFields = autoCreateServiceRecord && hasItem;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await completeReminder({
        id: reminderId,
        notes,
        serviceRecord: showServiceFields
          ? {
              summary: summary || 'Completed via reminder',
              cost: cost ? Number(cost) : undefined,
            }
          : undefined,
      });
      if (!result.ok) {
        setError(result.formError ?? 'Could not save');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 480 }}
    >
      <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column' }}>
        Notes (optional)
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={pending}
        />
      </label>
      {showServiceFields && (
        <>
          <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column' }}>
            Service summary
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={pending}
            />
          </label>
          <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column' }}>
            Cost (optional)
            <input
              type="number"
              step="0.01"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              disabled={pending}
            />
          </label>
        </>
      )}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save completion'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
