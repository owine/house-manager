'use client';

import { useEffect, useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { ActionResult } from '@/lib/result';

export type ReminderTargetSummary = {
  id: string;
  /** human label for the chip — vendor name, item name, system name, or generic */
  label: string;
  /** small badge text — "Item" or "System" — for the row */
  kind: 'item' | 'system';
};

export type CompleteReminderInput = {
  id: string;
  targetIds?: string[];
  notes?: string;
};

export type CompleteReminderAction = (
  input: CompleteReminderInput,
) => Promise<ActionResult<{ id: string }>>;

export type MarkCompleteDialogProps = {
  reminderId: string;
  reminderTitle: string;
  targets: ReminderTargetSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
  /** The completion server action. Passed in by the caller so tests can stub it
   * without pulling next-auth into jsdom. */
  action: CompleteReminderAction;
};

export function MarkCompleteDialog({
  reminderId,
  reminderTitle,
  targets,
  open,
  onOpenChange,
  onCompleted,
  action,
}: MarkCompleteDialogProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(targets.map((t) => [t.id, true])),
  );
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset internal state every time the dialog re-opens (or the target list
  // shifts under us); keeps stale "all unchecked" state from sticking.
  useEffect(() => {
    if (open) {
      setChecked(Object.fromEntries(targets.map((t) => [t.id, true])));
      setNotes('');
      setError(null);
    }
  }, [open, targets]);

  function toggle(id: string, next: boolean) {
    setChecked((prev) => ({ ...prev, [id]: next }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const targetIds = targets.filter((t) => checked[t.id]).map((t) => t.id);
    if (targetIds.length === 0) {
      setError('Select at least one target');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await action({ id: reminderId, targetIds, notes });
      if (!result.ok) {
        setError(result.formError ?? 'Could not save');
        return;
      }
      onCompleted?.();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Mark complete: {reminderTitle}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Targets</p>
            <ul className="flex flex-col gap-1" data-testid="mark-complete-targets-list">
              {targets.map((t) => {
                const cbId = `mark-complete-target-${t.id}`;
                return (
                  <li key={t.id}>
                    <label
                      htmlFor={cbId}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-muted/50"
                    >
                      <Checkbox
                        id={cbId}
                        checked={checked[t.id] ?? false}
                        onCheckedChange={(next) => toggle(t.id, next)}
                      />
                      <span className="text-sm">{t.label}</span>
                      <Badge variant="outline" className="ml-auto">
                        {t.kind === 'system' ? 'System' : 'Item'}
                      </Badge>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="mark-complete-notes" className="text-sm font-medium">
              Notes (optional)
            </label>
            <Textarea
              id="mark-complete-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              disabled={pending}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save completion'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
