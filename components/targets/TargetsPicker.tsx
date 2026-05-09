'use client';

import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { expandSystemSelection } from '@/lib/targets/expand';
import type { TargetInput } from '@/lib/targets/schema';

export interface AvailableItem {
  id: string;
  name: string;
  categoryName: string | null;
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
  value: TargetInput[];
  onChange: (next: TargetInput[]) => void;
  availableItems: AvailableItem[];
  availableSystems: AvailableSystem[];
  /** Optional id used to associate label / aria attrs in the parent form. */
  id?: string;
}

const UNCATEGORIZED = 'Uncategorized';

function hasItem(value: TargetInput[], itemId: string): boolean {
  return value.some((t) => t.itemId === itemId);
}

function hasSystem(value: TargetInput[], systemId: string): boolean {
  return value.some((t) => t.systemId === systemId);
}

function removeItem(value: TargetInput[], itemId: string): TargetInput[] {
  return value.filter((t) => t.itemId !== itemId);
}

function removeSystem(value: TargetInput[], systemId: string): TargetInput[] {
  return value.filter((t) => t.systemId !== systemId);
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
  id,
}: TargetsPickerProps) {
  const [query, setQuery] = useState('');
  const [systemsOpen, setSystemsOpen] = useState(true);
  const [itemsOpen, setItemsOpen] = useState(true);

  const activeItems = useMemo(
    () => availableItems.filter((i) => i.archivedAt === null),
    [availableItems],
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

  const selectedSystems = value.filter((t): t is { systemId: string } => Boolean(t.systemId));
  const selectedItems = value.filter((t): t is { itemId: string } => Boolean(t.itemId));

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
          placeholder="Search systems and items…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
          aria-label="Filter targets"
        />
      </div>

      {/* Selected chips */}
      {(selectedSystems.length > 0 || selectedItems.length > 0) && (
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
            aria-controls="targets-picker-systems-list"
          >
            {systemsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Systems
            <span className="ml-auto text-xs text-muted-foreground">{filteredSystems.length}</span>
          </Button>
          {systemsOpen && (
            <div
              id="targets-picker-systems-list"
              data-testid="targets-picker-systems-list"
              className="space-y-1 pl-6"
            >
              {filteredSystems.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">No systems match.</p>
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
            aria-controls="targets-picker-items-list"
          >
            {itemsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Items
            <span className="ml-auto text-xs text-muted-foreground">{filteredItems.length}</span>
          </Button>
          {itemsOpen && (
            <div
              id="targets-picker-items-list"
              data-testid="targets-picker-items-list"
              className="space-y-3 pl-6"
            >
              {itemsByCategory.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">No items match.</p>
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
    </div>
  );
}

export default TargetsPicker;
