'use client';

import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PART_KIND_LABELS } from '@/lib/parts/kind-labels';
import { expandSystemSelection } from '@/lib/targets/expand';
import type { PartTargetInput } from '@/lib/targets/schema';

export interface AvailableItem {
  id: string;
  name: string;
  categoryName: string | null;
  archivedAt: Date | null;
}

export interface AvailablePart {
  id: string;
  name: string;
  /** `PartKind` as a plain string; rendered through PART_KIND_LABELS. */
  kind: string | null;
  archivedAt: Date | null;
}

export interface AvailableSystem {
  id: string;
  name: string;
  kind: string | null;
  /** Active items in this system; archived items are filtered before auto-expand. */
  items: Array<{ id: string; archivedAt: Date | null }>;
}

export interface TargetsPickerProps {
  /**
   * The full target set. Rows this picker cannot render (a part row when
   * `allowParts` is off) are still carried through every `onChange` — see the
   * note on `allowParts`.
   */
  value: PartTargetInput[];
  onChange: (next: PartTargetInput[]) => void;
  availableItems: AvailableItem[];
  availableSystems: AvailableSystem[];
  availableParts?: AvailablePart[];
  /**
   * Opt-in Parts section. OFF by default, and deliberately so: only
   * `reminder_targets` and `service_record_targets` count three columns in
   * their CHECK constraint. `warranty_targets` and `incoming_email_targets`
   * keep a two-way XOR and have no `partId` column, so a part target emitted
   * from those forms would be rejected by the database — a 500, not a form
   * error.
   *
   * The TYPE stays wide for all four consumers (TargetInput and
   * PartTargetInput are mutually assignable), because every mutation below is
   * derived from `value` and filters on its own kind. That is what lets an
   * unrenderable part row survive a round-trip instead of being dropped and
   * then diff-deleted by the update action. Keep it that way.
   */
  allowParts?: boolean;
  /** Optional id used to associate label / aria attrs in the parent form. */
  id?: string;
}

const UNCATEGORIZED = 'Uncategorized';

function hasItem(value: PartTargetInput[], itemId: string): boolean {
  return value.some((t) => t.itemId === itemId);
}

function hasSystem(value: PartTargetInput[], systemId: string): boolean {
  return value.some((t) => t.systemId === systemId);
}

function hasPart(value: PartTargetInput[], partId: string): boolean {
  return value.some((t) => t.partId === partId);
}

function removeItem(value: PartTargetInput[], itemId: string): PartTargetInput[] {
  return value.filter((t) => t.itemId !== itemId);
}

function removeSystem(value: PartTargetInput[], systemId: string): PartTargetInput[] {
  return value.filter((t) => t.systemId !== systemId);
}

function removePart(value: PartTargetInput[], partId: string): PartTargetInput[] {
  return value.filter((t) => t.partId !== partId);
}

function partKindLabel(kind: string | null): string | null {
  if (!kind) return null;
  return PART_KIND_LABELS[kind as keyof typeof PART_KIND_LABELS] ?? kind;
}

function matches(haystack: string | null | undefined, needle: string): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function TargetsPicker({
  value,
  onChange,
  availableItems,
  availableSystems,
  availableParts,
  allowParts = false,
  id,
}: TargetsPickerProps) {
  const [query, setQuery] = useState('');
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);

  const activeItems = useMemo(
    () => availableItems.filter((i) => i.archivedAt === null),
    [availableItems],
  );

  const activeParts = useMemo(
    () => (availableParts ?? []).filter((p) => p.archivedAt === null),
    [availableParts],
  );

  const filteredSystems = useMemo(
    () => availableSystems.filter((s) => matches(s.name, query) || matches(s.kind, query)),
    [availableSystems, query],
  );

  const filteredItems = useMemo(
    () => activeItems.filter((i) => matches(i.name, query)),
    [activeItems, query],
  );

  const itemsByCategory = useMemo(() => {
    const map = new Map<string, AvailableItem[]>();
    for (const it of filteredItems) {
      const key = it.categoryName ?? UNCATEGORIZED;
      const list = map.get(key);
      if (list) list.push(it);
      else map.set(key, [it]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredItems]);

  const itemNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of availableItems) map.set(i.id, i.name);
    return map;
  }, [availableItems]);

  const systemNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of availableSystems) map.set(s.id, s.name);
    return map;
  }, [availableSystems]);

  const filteredParts = useMemo(
    () =>
      activeParts.filter((p) => matches(p.name, query) || matches(partKindLabel(p.kind), query)),
    [activeParts, query],
  );

  const partNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of availableParts ?? []) map.set(p.id, p.name);
    return map;
  }, [availableParts]);

  const selectedSystems = value.filter((t): t is { systemId: string } => Boolean(t.systemId));
  const selectedItems = value.filter((t): t is { itemId: string } => Boolean(t.itemId));
  // Part chips only render where parts are offered. Elsewhere a part row is
  // invisible but still present in `value` — and still round-trips out.
  const selectedParts = allowParts
    ? value.filter((t): t is { partId: string } => Boolean(t.partId))
    : [];

  const toggleItem = (itemId: string, checked: boolean) => {
    if (checked) {
      if (hasItem(value, itemId)) return;
      onChange([...value, { itemId }]);
    } else {
      onChange(removeItem(value, itemId));
    }
  };

  const toggleSystem = (system: AvailableSystem, checked: boolean) => {
    if (checked) {
      // Auto-expand: include the system + all active component items.
      onChange(expandSystemSelection(value, { id: system.id, items: system.items }));
    } else {
      // Uncheck only the system; do NOT cascade-uncheck previously-expanded items.
      onChange(removeSystem(value, system.id));
    }
  };

  const togglePart = (partId: string, checked: boolean) => {
    if (checked) {
      if (hasPart(value, partId)) return;
      onChange([...value, { partId }]);
    } else {
      onChange(removePart(value, partId));
    }
  };

  return (
    <div id={id} className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder={
            allowParts ? 'Search systems, items and parts…' : 'Search systems and items…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
          aria-label="Filter targets"
        />
      </div>

      {/* Selected chips */}
      {(selectedSystems.length > 0 || selectedItems.length > 0 || selectedParts.length > 0) && (
        <div className="flex flex-wrap gap-1.5" data-testid="targets-picker-chips">
          {selectedSystems.map((t) => (
            <Badge key={`s:${t.systemId}`} variant="secondary" className="gap-1 pr-1">
              <span>System: {systemNameById.get(t.systemId) ?? t.systemId}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove system ${systemNameById.get(t.systemId) ?? t.systemId}`}
                onClick={() => onChange(removeSystem(value, t.systemId))}
                className="size-4 rounded-sm hover:bg-foreground/10"
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
          {selectedItems.map((t) => (
            <Badge key={`i:${t.itemId}`} variant="outline" className="gap-1 pr-1">
              <span>{itemNameById.get(t.itemId) ?? t.itemId}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove item ${itemNameById.get(t.itemId) ?? t.itemId}`}
                onClick={() => onChange(removeItem(value, t.itemId))}
                className="size-4 rounded-sm hover:bg-foreground/10"
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
          {selectedParts.map((t) => (
            <Badge key={`p:${t.partId}`} variant="outline" className="gap-1 pr-1">
              <span>Part: {partNameById.get(t.partId) ?? t.partId}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove part ${partNameById.get(t.partId) ?? t.partId}`}
                onClick={() => onChange(removePart(value, t.partId))}
                className="size-4 rounded-sm hover:bg-foreground/10"
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}

      {/* Systems section */}
      <Card size="sm">
        <CardContent className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-mx-2 w-full justify-start gap-2 px-2 font-medium"
            onClick={() => setSystemsOpen((v) => !v)}
            aria-expanded={systemsOpen}
            // Only reference the list when it's actually rendered (it's mounted
            // conditionally) — a dangling aria-controls idref is an a11y defect.
            aria-controls={systemsOpen ? 'targets-picker-systems-list' : undefined}
          >
            {systemsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Systems
            {selectedSystems.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {selectedSystems.length} selected
              </Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{filteredSystems.length}</span>
          </Button>
          {systemsOpen && (
            <div
              id="targets-picker-systems-list"
              data-testid="targets-picker-systems-list"
              className="space-y-1 pl-6"
            >
              {filteredSystems.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">no systems match.</p>
              ) : (
                filteredSystems.map((system) => {
                  const checked = hasSystem(value, system.id);
                  const cbId = `targets-system-${system.id}`;
                  return (
                    <label
                      key={system.id}
                      htmlFor={cbId}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-muted/50"
                    >
                      <Checkbox
                        id={cbId}
                        checked={checked}
                        onCheckedChange={(next) => toggleSystem(system, next)}
                      />
                      <span className="text-sm">{system.name}</span>
                      {system.kind && (
                        <span className="text-xs text-muted-foreground">({system.kind})</span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Items section */}
      <Card size="sm">
        <CardContent className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-mx-2 w-full justify-start gap-2 px-2 font-medium"
            onClick={() => setItemsOpen((v) => !v)}
            aria-expanded={itemsOpen}
            aria-controls={itemsOpen ? 'targets-picker-items-list' : undefined}
          >
            {itemsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Items
            {selectedItems.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {selectedItems.length} selected
              </Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{filteredItems.length}</span>
          </Button>
          {itemsOpen && (
            <div
              id="targets-picker-items-list"
              data-testid="targets-picker-items-list"
              className="space-y-3 pl-6"
            >
              {itemsByCategory.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">no items match.</p>
              ) : (
                itemsByCategory.map(([category, items]) => (
                  <div key={category} className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">{category}</div>
                    {items.map((item) => {
                      const checked = hasItem(value, item.id);
                      const cbId = `targets-item-${item.id}`;
                      return (
                        <label
                          key={item.id}
                          htmlFor={cbId}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-muted/50"
                        >
                          <Checkbox
                            id={cbId}
                            checked={checked}
                            onCheckedChange={(next) => toggleItem(item.id, next)}
                          />
                          <span className="text-sm">{item.name}</span>
                        </label>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Parts section — only where the table's CHECK counts a partId column. */}
      {allowParts && (
        <Card size="sm">
          <CardContent className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mx-2 w-full justify-start gap-2 px-2 font-medium"
              onClick={() => setPartsOpen((v) => !v)}
              aria-expanded={partsOpen}
              aria-controls={partsOpen ? 'targets-picker-parts-list' : undefined}
            >
              {partsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              Parts
              {selectedParts.length > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {selectedParts.length} selected
                </Badge>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{filteredParts.length}</span>
            </Button>
            {partsOpen && (
              <div
                id="targets-picker-parts-list"
                data-testid="targets-picker-parts-list"
                className="space-y-1 pl-6"
              >
                {filteredParts.length === 0 ? (
                  <p className="py-1 text-xs text-muted-foreground">no parts match.</p>
                ) : (
                  filteredParts.map((part) => {
                    const checked = hasPart(value, part.id);
                    const cbId = `targets-part-${part.id}`;
                    const kindLabel = partKindLabel(part.kind);
                    return (
                      <label
                        key={part.id}
                        htmlFor={cbId}
                        className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-muted/50"
                      >
                        <Checkbox
                          id={cbId}
                          checked={checked}
                          onCheckedChange={(next) => togglePart(part.id, next)}
                        />
                        <span className="text-sm">{part.name}</span>
                        {kindLabel && (
                          <span className="text-xs text-muted-foreground">({kindLabel})</span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
