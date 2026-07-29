import { dropSystemCoveredItems } from '@/lib/reminders/target-coverage';
import type { CalendarDate } from '@/lib/time/tz';

// Pure grouping for digest emails. No I/O, no Prisma, no rendering — the rules
// live here precisely so they are testable without a database. See
// docs/superpowers/specs/2026-07-27-digest-system-grouping-design.md.

export type DigestTarget = { kind: 'item' | 'system'; id: string; name: string };

/** One `ReminderTarget` row, with its system already resolved by the query. */
export type DigestRow = {
  reminderId: string;
  title: string;
  dueOn: CalendarDate;
  daysOverdue: number;
  /** Singular and nullable: a standalone chore has no target at all. */
  target: DigestTarget | null;
  /** null = Unassigned. */
  system: { id: string; name: string } | null;
};

export type DigestEntry = {
  reminderId: string;
  title: string;
  dueOn: CalendarDate;
  daysOverdue: number;
  targets: DigestTarget[];
};

export type DigestGroup = {
  system: { id: string; name: string } | null;
  entries: DigestEntry[];
};

// Leading space cannot collide with a real System id: both System and Reminder
// ids are cuid() (see prisma/schema.prisma), whose alphabet is [0-9a-z].
const UNASSIGNED = ' unassigned';

/**
 * Project one entry's rows into its visible target list.
 *
 * `dueOn` is omitted from the coverage facts because the entry key already
 * contains it — every row here shares a due date, so agreement is structural.
 * A target whose date drifted lands in a *different* entry, one carrying no
 * system target, where nothing is suppressed.
 *
 * `itemSystemId` reads the row's resolved `system`, not its `target`:
 * `DigestTarget` is `{kind, id, name}` and has no parent pointer. The query
 * attributes an item row to its parent system (`lib/digests/queries.ts`), so
 * within a group the row's system *is* the item's parent.
 *
 * The `kind` guards are not equally load-bearing. `r.target?.kind === 'system'`
 * for `systemId` is essential: without it every row reports a non-null
 * `systemId` (since `r.system` is the group's system for item rows too), so no
 * row is ever a suppression candidate and coverage never fires. The
 * `r.target?.kind === 'item'` guard on `itemSystemId` is belt-and-braces — it
 * survives removal (mutation-tested) only because `dropSystemCoveredItems`
 * short-circuits on `systemId !== null` before ever reading `itemSystemId` for
 * a system row. Both stay so correctness is local to this function rather than
 * dependent on the helper's internal check order.
 */
function projectTargets(entryRows: readonly DigestRow[]): DigestTarget[] {
  const visible = dropSystemCoveredItems(entryRows, (r) => ({
    systemId: r.target?.kind === 'system' ? r.target.id : null,
    itemSystemId: r.target?.kind === 'item' ? (r.system?.id ?? null) : null,
  }));

  // The own-system drop below must come AFTER coverage filtering, not before:
  // the own-system target is what covers the items, so removing it first would
  // leave no system target for dropSystemCoveredItems to match against and
  // suppression would never fire.
  const out: DigestTarget[] = [];
  for (const r of visible) {
    if (r.target === null) continue; // standalone chore: no target at all
    // Drop the target that IS this group's system — the heading already names it.
    if (r.target.kind === 'system' && r.target.id === r.system?.id) continue;
    out.push(r.target);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collapse flat rows into one entry per (system, reminder, dueOn).
 *
 * `dueOn` is serialized into the key rather than used as a `Date`: two `Date`
 * objects for the same day are distinct Map keys by identity. `toISOString()`
 * is safe here because these are calendar dates pinned to UTC midnight.
 *
 * `daysOverdue` needs no reconciliation — the key includes `dueOn`, so every
 * row collapsing into one entry necessarily carries the same value. `title` has
 * the same invariant and is likewise taken from whichever row creates the entry.
 */
export function groupBySystem(rows: readonly DigestRow[]): DigestGroup[] {
  const bySystem = new Map<
    string,
    {
      system: DigestGroup['system'];
      entries: Map<string, { entry: Omit<DigestEntry, 'targets'>; rows: DigestRow[] }>;
    }
  >();

  for (const r of rows) {
    const systemKey = r.system?.id ?? UNASSIGNED;
    let group = bySystem.get(systemKey);
    if (!group) {
      group = { system: r.system, entries: new Map() };
      bySystem.set(systemKey, group);
    }

    // Space-joined for the same reason UNASSIGNED is space-prefixed: reminderId
    // is a cuid ([0-9a-z]) and toISOString() is fixed-format, so neither half
    // can contain the separator and the two parts cannot run together.
    const entryKey = `${r.reminderId} ${r.dueOn.toISOString()}`;
    let slot = group.entries.get(entryKey);
    if (!slot) {
      slot = {
        entry: {
          reminderId: r.reminderId,
          title: r.title,
          dueOn: r.dueOn,
          daysOverdue: r.daysOverdue,
        },
        rows: [],
      };
      group.entries.set(entryKey, slot);
    }

    // Rows are buffered rather than projected here: coverage is a property of
    // the whole entry, so no target can be judged until every row has arrived.
    slot.rows.push(r);
  }

  const groups = [...bySystem.values()].map((g) => ({
    system: g.system,
    entries: [...g.entries.values()]
      .map(({ entry, rows: entryRows }) => ({ ...entry, targets: projectTargets(entryRows) }))
      .sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime() || a.title.localeCompare(b.title)),
  }));

  // Systems alphabetical, Unassigned last. Ties break on id: System.name has no
  // uniqueness constraint, so two systems can share a name and ordering must
  // still be deterministic.
  return groups.sort((a, b) => {
    if (a.system === null) return b.system === null ? 0 : 1;
    if (b.system === null) return -1;
    return a.system.name.localeCompare(b.system.name) || a.system.id.localeCompare(b.system.id);
  });
}
