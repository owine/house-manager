'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SuggestionRow } from '@/components/ai/SuggestionRow';
import { Button } from '@/components/ui/button';
import type { ProposedChecklistItem, ProposedReminder } from '@/lib/ai/schemas';
import { saveAcceptedChecklist } from '@/lib/ai/suggest/checklist';
import { saveAcceptedReminders } from '@/lib/ai/suggest/reminders';

type RemindersPayload = {
  kind: 'reminders';
  logId: string;
  itemId?: string;
  proposals: ProposedReminder[];
};
type ChecklistPayload = {
  kind: 'checklist';
  logId: string;
  name: string;
  description?: string;
  appendToChecklistId?: string;
  items: ProposedChecklistItem[];
};
type Props = (RemindersPayload | ChecklistPayload) & {
  onSaved?: (savedCount: number) => void;
  onDiscard?: () => void;
};

export function SuggestionPreview(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const initialProposals =
    props.kind === 'reminders'
      ? props.proposals.map((p) => ({ ...p, _selected: true, _editing: false }))
      : props.items.map((p) => ({ ...p, _selected: true, _editing: false }));

  const form = useForm<{ proposals: typeof initialProposals }>({
    defaultValues: { proposals: initialProposals },
  });
  const { fields } = useFieldArray({ control: form.control, name: 'proposals' });

  const watched = form.watch('proposals');
  const selectedCount = watched.filter((r) => r._selected).length;

  const onSave = form.handleSubmit((data) => {
    const selected = data.proposals.filter((r) => r._selected);
    if (selected.length === 0) {
      toast.error('Select at least one row to save');
      return;
    }
    startTransition(async () => {
      if (props.kind === 'reminders') {
        const r = await saveAcceptedReminders({
          logId: props.logId,
          itemId: props.itemId,
          accepted: selected.map(
            ({ _selected: _s, _editing: _e, ...rest }) => rest as ProposedReminder,
          ),
        });
        if (!r.ok) {
          toast.error(r.formError ?? 'Failed to save');
          return;
        }
        toast.success(
          `Saved ${r.data.savedIds.length} reminder${r.data.savedIds.length === 1 ? '' : 's'}`,
        );
        setSavedCount(r.data.savedIds.length);
        props.onSaved?.(r.data.savedIds.length);
        router.refresh();
      } else {
        const r = await saveAcceptedChecklist({
          logId: props.logId,
          name: props.name,
          description: props.description,
          appendToChecklistId: props.appendToChecklistId,
          items: selected.map(
            ({ _selected: _s, _editing: _e, ...rest }) => rest as ProposedChecklistItem,
          ),
        });
        if (!r.ok) {
          toast.error(r.formError ?? 'Failed to save');
          return;
        }
        toast.success(
          `Saved checklist with ${selected.length} item${selected.length === 1 ? '' : 's'}`,
        );
        setSavedCount(selected.length);
        props.onSaved?.(selected.length);
        router.refresh();
      }
    });
  });

  function onDiscardAll() {
    setSavedCount(0);
    props.onDiscard?.();
  }

  if (savedCount !== null) {
    if (savedCount === 0) {
      return (
        <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
          Discarded.
        </div>
      );
    }
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm dark:bg-emerald-950/30">
        Saved {savedCount}.
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="rounded-md border p-4 text-sm text-muted-foreground">
        No suggestions for this context.
      </div>
    );
  }

  return (
    <form onSubmit={onSave} className="space-y-4">
      <ul className="rounded-md border">
        {fields.map((f, i) => (
          <SuggestionRow
            key={f.id}
            index={i}
            // biome-ignore lint/suspicious/noExplicitAny: SuggestionRow accepts Control<any> by design
            control={form.control as import('react-hook-form').Control<any>}
            kind={props.kind}
          />
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDiscardAll} disabled={pending}>
          Discard all
        </Button>
        <Button type="submit" disabled={pending || selectedCount === 0}>
          {pending ? 'Saving…' : `Save ${selectedCount} selected`}
        </Button>
      </div>
    </form>
  );
}
