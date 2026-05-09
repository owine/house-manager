import type { VendorRole } from '@prisma/client';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export type VendorItemLinkRow = {
  id: string;
  itemId: string;
  freeformName: string | null;
  role: VendorRole;
  /**
   * `systemId` lets the renderer nest item links under the linked system
   * row when both share a role. Null means the item isn't part of any
   * system, so it always renders flat.
   */
  item: { id: string; name: string; systemId: string | null } | null;
};

export type VendorSystemLinkRow = {
  id: string;
  systemId: string;
  freeformName: string | null;
  role: VendorRole;
  system: { id: string; name: string } | null;
};

type Props = {
  items: VendorItemLinkRow[];
  systems: VendorSystemLinkRow[];
};

const ROLE_ORDER: VendorRole[] = [
  'PURCHASE',
  'INSTALLER',
  'SERVICE',
  'WARRANTY_PROVIDER',
  'MANUFACTURER',
  'OTHER',
];

function roleLabel(role: VendorRole): string {
  switch (role) {
    case 'PURCHASE':
      return 'Purchase';
    case 'INSTALLER':
      return 'Installer';
    case 'SERVICE':
      return 'Service';
    case 'WARRANTY_PROVIDER':
      return 'Warranty';
    case 'MANUFACTURER':
      return 'Manufacturer';
    case 'OTHER':
      return 'Other';
    default:
      return role;
  }
}

function ItemRowContent({ row }: { row: VendorItemLinkRow }) {
  if (row.item) {
    return (
      <Link
        href={`/items/${row.item.id}`}
        className="underline-offset-2 hover:underline"
        data-testid={`vendor-linked-item-${row.id}`}
      >
        {row.item.name}
      </Link>
    );
  }
  return <span className="text-muted-foreground">{row.freeformName ?? 'Unknown item'}</span>;
}

function SystemRowContent({ row }: { row: VendorSystemLinkRow }) {
  if (row.system) {
    return (
      <Link
        href={`/systems/${row.system.id}`}
        className="font-medium underline-offset-2 hover:underline"
        data-testid={`vendor-linked-system-${row.id}`}
      >
        {row.system.name}
      </Link>
    );
  }
  return (
    <span className="font-medium text-muted-foreground">
      {row.freeformName ?? 'Unknown system'}
    </span>
  );
}

/**
 * Unified vendor-links view. Groups all links by role; within each role
 * group, item rows that belong to a system *also linked at the same role*
 * are nested under that system row rather than rendered flat. Items with
 * no parent system, or whose parent system isn't linked at the same role,
 * render at the same level as systems.
 *
 * Replaces the previous two-card layout (separate `VendorLinkedItemsSection`
 * + `VendorLinkedSystemsSection`).
 */
export function VendorLinksSection({ items, systems }: Props) {
  const totalLinks = items.length + systems.length;

  // Pre-bucket per role so we can render each section independently.
  const itemsByRole = new Map<VendorRole, VendorItemLinkRow[]>();
  for (const i of items) {
    const arr = itemsByRole.get(i.role) ?? [];
    arr.push(i);
    itemsByRole.set(i.role, arr);
  }
  const systemsByRole = new Map<VendorRole, VendorSystemLinkRow[]>();
  for (const s of systems) {
    const arr = systemsByRole.get(s.role) ?? [];
    arr.push(s);
    systemsByRole.set(s.role, arr);
  }

  const presentRoles = ROLE_ORDER.filter((r) => itemsByRole.has(r) || systemsByRole.has(r));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Linked items &amp; systems ({totalLinks})</CardTitle>
      </CardHeader>
      <CardContent>
        {totalLinks === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="vendor-links-empty">
            No items or systems linked yet.
          </p>
        ) : (
          <div className="flex flex-col gap-5" data-testid="vendor-links">
            {presentRoles.map((role) => {
              const roleItems = itemsByRole.get(role) ?? [];
              const roleSystems = systemsByRole.get(role) ?? [];

              // Build the nested structure: for this role, which items
              // belong to a system that's ALSO linked at this role?
              const linkedSystemIdsAtRole = new Set(
                roleSystems.map((s) => s.system?.id).filter((id): id is string => Boolean(id)),
              );
              const childrenBySystem = new Map<string, VendorItemLinkRow[]>();
              const orphanItems: VendorItemLinkRow[] = [];
              for (const i of roleItems) {
                const parentId = i.item?.systemId;
                if (parentId && linkedSystemIdsAtRole.has(parentId)) {
                  const arr = childrenBySystem.get(parentId) ?? [];
                  arr.push(i);
                  childrenBySystem.set(parentId, arr);
                } else {
                  orphanItems.push(i);
                }
              }

              return (
                <section key={role} className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {roleLabel(role)}
                  </h3>
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {roleSystems.map((sys) => {
                      const children = sys.system
                        ? (childrenBySystem.get(sys.system.id) ?? [])
                        : [];
                      return (
                        <li key={sys.id} className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="text-[10px] uppercase">
                              System
                            </Badge>
                            <SystemRowContent row={sys} />
                          </div>
                          {children.length > 0 && (
                            <ul
                              className="ml-6 flex flex-col gap-1"
                              data-testid={`vendor-link-children-${sys.id}`}
                            >
                              {children.map((child) => (
                                <li key={child.id} className="flex items-center gap-2">
                                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] uppercase tracking-wide"
                                  >
                                    Item
                                  </Badge>
                                  <ItemRowContent row={child} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                    {orphanItems.map((it) => (
                      <li key={it.id} className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                          Item
                        </Badge>
                        <ItemRowContent row={it} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
