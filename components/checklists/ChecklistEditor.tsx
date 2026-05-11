'use client';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { SuggestChecklistItemsButton } from '@/components/ai/SuggestChecklistItemsButton';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  addChecklistItem,
  deleteChecklist,
  deleteChecklistItem,
  reorderChecklistItems,
  resetChecklist,
  setChecklistActive,
  toggleChecklistItem,
  updateChecklist,
} from '@/lib/checklists/actions';
import { ChecklistMetaForm } from './ChecklistMetaForm';

type ItemRow = {
  id: string;
  title: string;
  position: number;
  completedAt: Date | null;
  item: { id: string; name: string } | null;
};

type Props = {
  checklist: {
    id: string;
    name: string;
    description: string | null;
    active: boolean;
    items: ItemRow[];
  };
};

export function ChecklistEditor({ checklist }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [newItemTitle, setNewItemTitle] = useState('');

  function move(itemId: string, direction: 'up' | 'down') {
    const ordered = [...checklist.items].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= ordered.length) return;
    [ordered[idx], ordered[swapWith]] = [ordered[swapWith], ordered[idx]];
    startTransition(async () => {
      const r = await reorderChecklistItems({
        checklistId: checklist.id,
        orderedItemIds: ordered.map((i) => i.id),
      });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to reorder');
        return;
      }
      router.refresh();
    });
  }

  function onDelete(itemId: string) {
    startTransition(async () => {
      const r = await deleteChecklistItem({ id: itemId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to delete item');
        return;
      }
      toast.success('Item removed');
      router.refresh();
    });
  }

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = newItemTitle.trim();
    if (!title) return;
    startTransition(async () => {
      const r = await addChecklistItem({ checklistId: checklist.id, title });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to add item');
        return;
      }
      setNewItemTitle('');
      router.refresh();
    });
  }

  function onToggle(itemId: string, done: boolean) {
    startTransition(async () => {
      const r = await toggleChecklistItem({ id: itemId, done });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to update item');
        return;
      }
      router.refresh();
    });
  }

  function onReset() {
    startTransition(async () => {
      const r = await resetChecklist({ id: checklist.id });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to reset');
        return;
      }
      toast.success('Checklist reset — every item is now unchecked');
      router.refresh();
    });
  }

  function onToggleArchive() {
    const next = !checklist.active;
    startTransition(async () => {
      const r = await setChecklistActive({ id: checklist.id, active: next });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to update');
        return;
      }
      toast.success(next ? 'Checklist restored' : 'Checklist archived');
      router.refresh();
    });
  }

  function onDeleteChecklist() {
    startTransition(async () => {
      const r = await deleteChecklist(checklist.id);
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to delete checklist');
        return;
      }
      toast.success('Checklist deleted');
      router.push('/checklists');
    });
  }

  const orderedItems = [...checklist.items].sort((a, b) => a.position - b.position);
  const completedCount = orderedItems.filter((i) => i.completedAt !== null).length;
  const totalCount = orderedItems.length;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const allDone = totalCount > 0 && completedCount === totalCount;

  return (
    <div className="space-y-8">
      <ChecklistMetaForm
        defaultValues={{
          id: checklist.id,
          name: checklist.name,
          description: checklist.description,
        }}
        action={updateChecklist}
        submitLabel="Save changes"
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Items</h2>
          <SuggestChecklistItemsButton checklistId={checklist.id} checklistName={checklist.name} />
        </div>
        {totalCount > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {completedCount}/{totalCount} done
              </span>
              <span className={allDone ? 'font-medium text-green-600 dark:text-green-400' : ''}>
                {pct}%
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full transition-all ${allDone ? 'bg-green-600 dark:bg-green-400' : 'bg-primary'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}
        {orderedItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items yet. Add one below.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {orderedItems.map((row, i) => (
              <li key={row.id} className="flex items-center gap-2 p-3">
                <Checkbox
                  checked={row.completedAt !== null}
                  onCheckedChange={(checked) => onToggle(row.id, checked)}
                  disabled={pending}
                  aria-label={`Mark "${row.title}" as ${row.completedAt ? 'not done' : 'done'}`}
                />
                <div className="flex-1">
                  <p
                    className={`font-medium${row.completedAt ? ' text-muted-foreground line-through' : ''}`}
                  >
                    {row.title}
                  </p>
                  {row.item && <p className="text-sm text-muted-foreground">→ {row.item.name}</p>}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending || i === 0}
                  onClick={() => move(row.id, 'up')}
                  aria-label="Move up"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending || i === orderedItems.length - 1}
                  onClick={() => move(row.id, 'down')}
                  aria-label="Move down"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending}
                  onClick={() => onDelete(row.id)}
                  aria-label="Delete item"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={onAdd} className="flex gap-2">
          <Input
            placeholder="New item title…"
            value={newItemTitle}
            onChange={(e) => setNewItemTitle(e.target.value)}
            disabled={pending}
          />
          <Button type="submit" disabled={pending || !newItemTitle.trim()}>
            Add
          </Button>
        </form>
      </section>

      <section className="flex flex-wrap items-center gap-2 border-t pt-6">
        <Button variant="outline" disabled={pending || completedCount === 0} onClick={onReset}>
          Reset items
        </Button>
        <Button variant="outline" disabled={pending} onClick={onToggleArchive}>
          {checklist.active ? 'Archive' : 'Restore'}
        </Button>
        <div className="flex-1" />
        <Button variant="destructive" disabled={pending} onClick={onDeleteChecklist}>
          Delete checklist
        </Button>
      </section>
    </div>
  );
}
