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

const UNASSIGNED = ' unassigned';

/**
 * Collapse flat rows into one entry per (system, reminder, dueOn).
 *
 * `dueOn` is serialized into the key rather than used as a `Date`: two `Date`
 * objects for the same day are distinct Map keys by identity. `toISOString()`
 * is safe here because these are calendar dates pinned to UTC midnight.
 *
 * `daysOverdue` needs no reconciliation — the key includes `dueOn`, so every
 * row collapsing into one entry necessarily carries the same value.
 */
export function groupBySystem(rows: readonly DigestRow[]): DigestGroup[] {
  const bySystem = new Map<
    string,
    { system: DigestGroup['system']; entries: Map<string, DigestEntry> }
  >();

  for (const r of rows) {
    const systemKey = r.system?.id ?? UNASSIGNED;
    let group = bySystem.get(systemKey);
    if (!group) {
      group = { system: r.system, entries: new Map() };
      bySystem.set(systemKey, group);
    }

    const entryKey = `${r.reminderId} ${r.dueOn.toISOString()}`;
    let entry = group.entries.get(entryKey);
    if (!entry) {
      entry = {
        reminderId: r.reminderId,
        title: r.title,
        dueOn: r.dueOn,
        daysOverdue: r.daysOverdue,
        targets: [],
      };
      group.entries.set(entryKey, entry);
    }

    // Drop a target that IS this group's system — the heading already names it.
    // This must fire regardless of how many other targets the entry has: a
    // reminder may legitimately target both an item and the system owning it
    // (targetSchema's XOR is per-target; targetsArraySchema allows an array).
    const isOwnSystem =
      r.target !== null && r.target.kind === 'system' && r.target.id === r.system?.id;
    if (r.target !== null && !isOwnSystem) {
      entry.targets.push(r.target);
    }
  }

  const groups = [...bySystem.values()].map((g) => ({
    system: g.system,
    entries: [...g.entries.values()]
      .map((e) => ({
        ...e,
        targets: [...e.targets].sort((a, b) => a.name.localeCompare(b.name)),
      }))
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
