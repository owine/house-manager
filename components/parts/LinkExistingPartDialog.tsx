'use client';

import type { PartKind } from '@prisma/client';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PART_KIND_LABELS } from '@/components/parts/kind-labels';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { linkPartToParent } from '@/lib/parts/actions';

export type PickerPart = {
  id: string;
  name: string;
  kind: PartKind;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exactly one of these is set — mirrors the XOR on `part_links`. */
  itemId?: string;
  systemId?: string;
  /** Live parts across the house, from `listPartsForPicker()`. */
  parts: PickerPart[];
  /** Part ids already linked to this parent; shown but not selectable. */
  linkedPartIds: string[];
};

export function LinkExistingPartDialog({
  open,
  onOpenChange,
  itemId,
  systemId,
  parts,
  linkedPartIds,
}: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const linked = useMemo(() => new Set(linkedPartIds), [linkedPartIds]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return parts;
    return parts.filter((p) => p.name.toLowerCase().includes(q));
  }, [parts, query]);

  function handleLink() {
    if (!selected) return;
    startTransition(async () => {
      const r = await linkPartToParent({ partId: selected, itemId, systemId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to link part');
        return;
      }
      toast.success('Part linked');
      onOpenChange(false);
      setSelected(null);
      setQuery('');
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link an existing part</DialogTitle>
          <DialogDescription>
            Search the parts you already track and attach one to this {itemId ? 'item' : 'system'}.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search parts by name"
          aria-label="Search parts"
          data-testid="link-part-search"
        />

        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {parts.length === 0
              ? 'No parts yet. Use “Add part” to create one.'
              : 'No parts match that search.'}
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {matches.map((p) => {
              const already = linked.has(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={already}
                    className={`w-full rounded-md border p-2 text-left text-sm transition-colors disabled:opacity-50 ${
                      selected === p.id ? 'border-primary bg-primary/10' : 'hover:bg-muted'
                    }`}
                    onClick={() => setSelected(p.id)}
                    data-testid={`link-part-pick-${p.id}`}
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {PART_KIND_LABELS[p.kind]}
                      {already && ' · already linked'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter showCloseButton>
          <Button
            type="button"
            onClick={handleLink}
            disabled={!selected || pending}
            data-testid="link-part-confirm"
          >
            Link part
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
