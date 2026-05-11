'use client';

import { Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { assignItemToSystem, unassignItemFromSystem } from '@/lib/systems/actions';

type ComponentRow = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
};

type OrphanItem = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
};

type Props = {
  systemId: string;
  components: ComponentRow[];
  orphanItems: OrphanItem[];
};

export function ComponentsList({ systemId, components, orphanItems }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleAdd() {
    if (!selected) return;
    startTransition(async () => {
      const r = await assignItemToSystem({ itemId: selected, systemId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to add component');
        return;
      }
      toast.success('Component added');
      setOpen(false);
      setSelected(null);
    });
  }

  function handleRemove(itemId: string) {
    startTransition(async () => {
      const r = await unassignItemFromSystem({ itemId });
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to remove component');
        return;
      }
      toast.success('Component removed from system');
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Components ({components.length})</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={orphanItems.length === 0}
          data-testid="components-add-trigger"
        >
          <Plus className="h-4 w-4" />
          Add component
        </Button>
      </CardHeader>
      <CardContent>
        {components.length === 0 ? (
          <p className="text-sm text-muted-foreground">No components in this system yet.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {components.map((c) => (
              <li
                key={c.id}
                className="flex items-start justify-between gap-2 rounded-md border p-3"
              >
                <div className="flex flex-col">
                  <Link href={`/items/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  {(c.manufacturer || c.model) && (
                    <span className="text-xs text-muted-foreground">
                      {[c.manufacturer, c.model].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleRemove(c.id)}
                  disabled={pending}
                  aria-label={`Remove ${c.name} from system`}
                  data-testid={`components-remove-${c.id}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a component</DialogTitle>
            <DialogDescription>
              Pick an item that isn&apos;t already assigned to a system.
            </DialogDescription>
          </DialogHeader>
          {orphanItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No unassigned items available. Create or unassign an item first.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto space-y-1">
              {orphanItems.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    className={`w-full rounded-md border p-2 text-left text-sm transition-colors ${
                      selected === it.id ? 'border-primary bg-primary/10' : 'hover:bg-muted'
                    }`}
                    onClick={() => setSelected(it.id)}
                    data-testid={`components-pick-${it.id}`}
                  >
                    <div className="font-medium">{it.name}</div>
                    {(it.manufacturer || it.model) && (
                      <div className="text-xs text-muted-foreground">
                        {[it.manufacturer, it.model].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter showCloseButton>
            <Button
              type="button"
              onClick={handleAdd}
              disabled={!selected || pending}
              data-testid="components-add-confirm"
            >
              Add to system
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
