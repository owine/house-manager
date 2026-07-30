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
  /**
   * Part targets exist on `reminder_targets` and `service_record_targets` only.
   * `warranty_targets` keeps a two-way XOR and never gains `partId`, and
   * <WarrantyTable> shares this component — so both part fields are OPTIONAL.
   * Making them required breaks the warranty caller.
   */
  partId?: string | null;
  part?: { id: string; name: string } | null;
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
  kind: 'item' | 'system' | 'part';
  /**
   * null = render the label unlinked. Parts have no detail route yet (PR 1b
   * adds /parts/[id]); linking there today would be a guaranteed 404, so a part
   * chip deliberately renders as plain text.
   */
  href: string | null;
  name: string;
};

const KIND_LABELS: Record<Resolved['kind'], string> = {
  item: 'Item',
  system: 'System',
  part: 'Part',
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
    } else if (t.part) {
      out.push({
        key: t.id,
        kind: 'part',
        href: null,
        name: t.part.name,
      });
    }
    // A target with no item, system or part is malformed (or is a standalone
    // chore's cadence-carrying sentinel row); it renders nothing.
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
              {KIND_LABELS[r.kind]}
            </span>
            {inert || r.href === null ? (
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
