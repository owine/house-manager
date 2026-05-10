'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Mark complete
      </Button>
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
    <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-sm">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="complete-notes" className="text-sm font-medium">
          Notes (optional)
        </label>
        <Textarea
          id="complete-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={pending}
        />
      </div>
      {showServiceFields && (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="complete-summary" className="text-sm font-medium">
              Service summary
            </label>
            <Input
              id="complete-summary"
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="complete-cost" className="text-sm font-medium">
              Cost (optional)
            </label>
            <Input
              id="complete-cost"
              type="number"
              className="w-32"
              step="0.01"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              disabled={pending}
            />
          </div>
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} size="sm">
          {pending ? 'Saving…' : 'Save completion'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
