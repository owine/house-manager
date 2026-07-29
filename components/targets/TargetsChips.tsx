import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { dropSystemCoveredItems } from '@/lib/reminders/target-coverage';

export interface TargetSummary {
  id: string;
  itemId: string | null;
  systemId: string | null;
  /**
   * Optional `systemId` on an item target — when set, feeds
   * `dropSystemCoveredItems` (lib/reminders/target-coverage.ts), which drops
   * item chips whose parent system is already in the same target set
   * (showing the system implies its items, so the item chips become noise).
   * Callers that don't have system context just omit it.
   */
  item: { id: string; name: string; systemId?: string | null } | null;
  system: { id: string; name: string } | null;
}

export interface TargetsChipsProps {
  targets: TargetSummary[];
  /**
   * When true, suppresses the link wrapping (e.g., when already on that
   * entity's page or rendering inside a parent link). Default false.
   */
  inert?: boolean;
}

type Resolved = {
  key: string;
  kind: 'item' | 'system';
  href: string;
  name: string;
};

function resolve(targets: TargetSummary[]): Resolved[] {
  // No `dueOn`: chips carry no date context, so coverage is decided on
  // parentage alone.
  const visible = dropSystemCoveredItems(targets, (t) => ({
    systemId: t.system?.id ?? null,
    itemSystemId: t.item?.systemId ?? null,
  }));

  const out: Resolved[] = [];
  for (const t of visible) {
    if (t.system) {
      out.push({
        key: t.id,
        kind: 'system',
        href: `/systems/${t.system.id}`,
        name: t.system.name,
      });
    } else if (t.item) {
      out.push({
        key: t.id,
        kind: 'item',
        href: `/items/${t.item.id}`,
        name: t.item.name,
      });
    }
    // A target with neither item nor system is malformed; it renders nothing.
  }
  return out;
}

export function TargetsChips({ targets, inert = false }: TargetsChipsProps) {
  const resolved = resolve(targets);

  if (resolved.length === 0) {
    return (
      <span className="text-sm text-muted-foreground" data-testid="targets-chips-empty">
        —
      </span>
    );
  }

  return (
    <ul className="flex flex-wrap gap-1.5" data-testid="targets-chips">
      {resolved.map((r) => {
        const label = (
          <Badge variant="secondary" className="gap-1.5" data-testid={`targets-chip-${r.key}`}>
            <span className="rounded-sm bg-foreground/10 px-1 text-[10px] font-semibold tracking-wide uppercase">
              {r.kind === 'system' ? 'System' : 'Item'}
            </span>
            {inert ? (
              <span data-testid={`targets-chip-text-${r.key}`}>{r.name}</span>
            ) : (
              <Link
                href={r.href}
                className="underline-offset-2 hover:underline"
                data-testid={`targets-chip-link-${r.key}`}
              >
                {r.name}
              </Link>
            )}
          </Badge>
        );

        return (
          <li key={r.key} className="inline-flex">
            {label}
          </li>
        );
      })}
    </ul>
  );
}
