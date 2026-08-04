'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PART_KIND_LABELS } from '@/lib/parts/kind-labels';
import type { SystemPartSummary } from '@/lib/systems/actions';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  systemName: string;
  parts: SystemPartSummary[];
  /** Injected by the server page — see the action skeleton in CLAUDE.md. */
  onConfirm: (input: {
    archivePartIds: string[];
    keepPartIds: string[];
  }) => Promise<
    | { ok: true; archivedCount: number; keptCount: number }
    | { ok: false; hasParts: true; parts: SystemPartSummary[] }
    | { ok: false; formError?: string }
  >;
};

/**
 * Default-checked is `willBeOrphaned` only. A part still linked to two other
 * fixtures must not be archived just because one of its parents is going away.
 */
export function defaultCheckedPartIds(parts: SystemPartSummary[]): string[] {
  return parts.filter((p) => p.willBeOrphaned).map((p) => p.id);
}

export function DeleteSystemPartsDialog({
  open,
  onOpenChange,
  systemName,
  parts,
  onConfirm,
}: Props) {
  // The server may hand back a *fresh* list when the links changed under us, so
  // the rendered list is state, not the prop.
  const [rows, setRows] = useState(parts);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(defaultCheckedPartIds(parts)));
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setRows(parts);
    setChecked(new Set(defaultCheckedPartIds(parts)));
  }, [parts]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    const archivePartIds = rows.filter((p) => checked.has(p.id)).map((p) => p.id);
    const keepPartIds = rows.filter((p) => !checked.has(p.id)).map((p) => p.id);
    startTransition(async () => {
      const r = await onConfirm({ archivePartIds, keepPartIds });
      if (r.ok) {
        toast.success(`System deleted · ${r.archivedCount} archived, ${r.keptCount} kept`);
        onOpenChange(false);
        return;
      }
      if ('hasParts' in r) {
        setRows(r.parts);
        setChecked(new Set(defaultCheckedPartIds(r.parts)));
        toast.error('The parts on this system changed — review the updated list.');
        return;
      }
      toast.error(r.formError ?? 'Failed to delete system');
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {systemName}?</DialogTitle>
          <DialogDescription>
            These parts are linked to it. Checked parts are archived; unchecked parts are kept and
            simply unlinked. Deleting the system cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setChecked(new Set(rows.map((p) => p.id)))}
            data-testid="delete-system-select-all"
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setChecked(new Set())}
            data-testid="delete-system-select-none"
          >
            Select none
          </Button>
        </div>

        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {rows.map((p) => {
            const inputId = `delete-system-part-${p.id}`;
            return (
              <li key={p.id} className="flex items-start gap-3 rounded-md border p-2">
                <Checkbox
                  id={inputId}
                  checked={checked.has(p.id)}
                  onCheckedChange={() => toggle(p.id)}
                  data-testid={`delete-system-part-${p.id}`}
                />
                {/* label[for], not the bare collapsed control — Playwright
                    errors with "outside of viewport" on the latter. */}
                <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer text-sm">
                  {/* Part.name is user-supplied: text, never markup. */}
                  <span className="font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {PART_KIND_LABELS[p.kind]}
                    {p.willBeOrphaned
                      ? ' · not linked to anything else'
                      : ' · still linked elsewhere'}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <DialogFooter showCloseButton>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
            data-testid="delete-system-confirm"
          >
            Delete system
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
