import Link from 'next/link';
import { Badge } from '@/components/ui/badge';

export interface TargetSummary {
  id: string;
  itemId: string | null;
  systemId: string | null;
  /**
   * Optional `systemId` on an item target — when set, lets the chip renderer
   * dedupe item chips that belong to a system already in the same target
   * set (showing the system implies its items, so the item chips become
   * noise). Callers that don't have system context just omit it.
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
  // Collect the set of system ids in this target list — items whose
  // `systemId` matches one of these are duplicative (the system chip
  // already implies them) and get hidden.
  const systemIdsPresent = new Set<string>();
  for (const t of targets) {
    if (t.system) systemIdsPresent.add(t.system.id);
  }

  const out: Resolved[] = [];
  for (const t of targets) {
    if (t.system) {
      out.push({
        key: t.id,
        kind: 'system',
        href: `/systems/${t.system.id}`,
        name: t.system.name,
      });
    } else if (t.item) {
      // Skip an item chip when its parent system is also in the target set.
      if (t.item.systemId && systemIdsPresent.has(t.item.systemId)) continue;
      out.push({
        key: t.id,
        kind: 'item',
        href: `/items/${t.item.id}`,
        name: t.item.name,
      });
    }
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
