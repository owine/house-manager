'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { completeReminder } from '@/lib/reminders/actions';
import { MarkCompleteDialog, type ReminderTargetSummary } from './MarkCompleteDialog';

type Props = {
  reminderId: string;
  reminderTitle: string;
  targets: ReminderTargetSummary[];
};

/**
 * "Mark complete" entry point. Reminders with 2+ targets open
 * `MarkCompleteDialog` so the user can pick which targets the completion
 * covers; single-target reminders skip the dialog and call the action
 * directly with that one target.
 */
export function MarkCompleteButton({ reminderId, reminderTitle, targets }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (targets.length === 0) return null;

  function handleClick() {
    if (targets.length >= 2) {
      setOpen(true);
      return;
    }
    const onlyId = targets[0].id;
    startTransition(async () => {
      const result = await completeReminder({
        id: reminderId,
        targetIds: [onlyId],
        notes: '',
      });
      if (!result.ok) {
        toast.error(result.formError ?? 'Could not save');
        return;
      }
      toast.success('Marked complete');
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={handleClick} disabled={pending}>
        Mark complete
      </Button>
      {targets.length >= 2 && (
        <MarkCompleteDialog
          reminderId={reminderId}
          reminderTitle={reminderTitle}
          targets={targets}
          open={open}
          onOpenChange={setOpen}
          onCompleted={() => router.refresh()}
          action={completeReminder}
        />
      )}
    </>
  );
}
