'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PART_KIND_LABELS } from '@/lib/parts/kind-labels';
import { PART_KINDS } from '@/lib/parts/schema';

// Sentinels for the "no filter" choices. Base UI's Select treats '' as a
// placeholder state, so an empty string cannot be a real option value; hidden
// inputs translate the sentinel back to "absent" on submit.
const ALL_KINDS = '__all_kinds__';
const ALL_PARENTS = '__all_parents__';

/** `item:<id>` / `system:<id>` — one Select drives two query params. */
const ITEM_PREFIX = 'item:';
const SYSTEM_PREFIX = 'system:';

type ParentOption = { id: string; name: string };

type Props = {
  q: string;
  selectedKind: string;
  selectedItemId: string;
  selectedSystemId: string;
  showArchived: boolean;
  items: ParentOption[];
  systems: ParentOption[];
};

export function PartsFilterBar({
  q,
  selectedKind,
  selectedItemId,
  selectedSystemId,
  showArchived,
  items,
  systems,
}: Props) {
  const initialParent = selectedItemId
    ? `${ITEM_PREFIX}${selectedItemId}`
    : selectedSystemId
      ? `${SYSTEM_PREFIX}${selectedSystemId}`
      : ALL_PARENTS;

  const [kind, setKind] = useState<string>(selectedKind || ALL_KINDS);
  const [parent, setParent] = useState<string>(initialParent);
  const [archived, setArchived] = useState<boolean>(showArchived);

  const hasFilters =
    q.length > 0 ||
    selectedKind.length > 0 ||
    selectedItemId.length > 0 ||
    selectedSystemId.length > 0 ||
    showArchived;

  const kindFormValue = kind === ALL_KINDS ? '' : kind;
  const itemFormValue = parent.startsWith(ITEM_PREFIX) ? parent.slice(ITEM_PREFIX.length) : '';
  const systemFormValue = parent.startsWith(SYSTEM_PREFIX)
    ? parent.slice(SYSTEM_PREFIX.length)
    : '';

  const kindItems = [
    { label: 'All kinds', value: ALL_KINDS },
    ...PART_KINDS.map((k) => ({ label: PART_KIND_LABELS[k], value: k })),
  ];
  const parentItems = [
    { label: 'All parents', value: ALL_PARENTS },
    ...systems.map((s) => ({ label: `System · ${s.name}`, value: `${SYSTEM_PREFIX}${s.id}` })),
    ...items.map((i) => ({ label: `Item · ${i.name}`, value: `${ITEM_PREFIX}${i.id}` })),
  ];

  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="kind" value={kindFormValue} />
      <input type="hidden" name="item" value={itemFormValue} />
      <input type="hidden" name="system" value={systemFormValue} />

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="parts-filter-q">Search</label>
        <Input
          id="parts-filter-q"
          name="q"
          defaultValue={q}
          placeholder="Name, manufacturer, model, SKU..."
        />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="parts-filter-kind">Kind</label>
        <Select items={kindItems} value={kind} onValueChange={(v) => setKind(v ?? ALL_KINDS)}>
          <SelectTrigger id="parts-filter-kind" className="w-[12rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kindItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="parts-filter-parent">Parent</label>
        <Select
          items={parentItems}
          value={parent}
          onValueChange={(v) => setParent(v ?? ALL_PARENTS)}
        >
          <SelectTrigger id="parts-filter-parent" className="w-[14rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {parentItems.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Base UI's Checkbox renders a styled non-form button, so a form-GET
          needs this mirror input to drive the URL query. */}
      {archived && <input type="hidden" name="archived" value="true" />}
      <Label
        htmlFor="parts-filter-archived"
        className="flex items-center gap-1.5 text-sm font-normal"
      >
        <Checkbox
          id="parts-filter-archived"
          checked={archived}
          onCheckedChange={(c) => setArchived(c === true)}
        />
        Show archived
      </Label>

      <Button type="submit" variant="outline">
        Filter
      </Button>

      {hasFilters && (
        <Button variant="ghost" render={<Link href="/parts" />}>
          Clear
        </Button>
      )}
    </form>
  );
}
