# Digest System Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group reminder digest emails under system headings, and collapse a reminder's multiple targets into one entry instead of repeating the reminder per target.

**Architecture:** The query stays a fetch and gains system attribution; a new pure `groupBySystem` turns flat rows into `(system, reminder, dueOn)` groups; the email template renders those groups. Putting the rules in a pure function is the point — today they would only be reachable through a Testcontainers integration test.

**Tech Stack:** TypeScript, Prisma 7.9 / Postgres 18, React email templates rendered to HTML + text, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-07-27-digest-system-grouping-design.md` (commit `ef7e5c6`)

**Branch:** `feat/digest-system-grouping`

---

## Read this before Task 1

**`dueOn` is a calendar date, not an instant.** `ReminderTarget.nextDueOn` is `@db.Date` (`prisma/schema.prisma:495`), stored at UTC midnight. Per `lib/time/tz.ts`, never run it through a timezone — `formatCalendarDate` forces UTC, and that is deliberate. The house timezone appears in this code exactly once, in `startOfDayUtc(now, timezone)`, which answers "what day is it now" so `daysOverdue` is measured from the right day. **Do not touch that line or its comment.**

**Every commit must leave the tree green.** The type change crosses three files, but it splits across **Task 2 and Task 3** — one green commit each — because `DigestEntry` is shape-identical to the template's existing `DigestItem`. Task 2 changes the query and has the worker flatten groups back into a flat array, so the template compiles untouched and the duplicate-entry bug is already fixed. Task 3 then rewires the template to render headings.

(That assignability is verified, not assumed: a source type with a union-valued discriminant — `kind: 'item' | 'system'` — is structurally assignable to a target union of two literal-discriminant object types, provided the other fields match. They do.)

Use `pnpm`, never `npx`/`npm`. Never `git commit --no-verify` — and note commits can fail *silently* behind the Biome pre-commit hook, so run `git log --oneline -1` after each and confirm HEAD moved.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `lib/digests/group.ts` | Pure. `DigestRow` → `DigestGroup[]`. No I/O, no imports beyond types. |
| `lib/digests/group.test.ts` | Unit tests for every grouping rule. No database. |

**Modified:**

| File | Change |
|---|---|
| `lib/digests/queries.ts` | Fetch `item.system`; return `DigestRow` (singular `target`, plus `system`) — Task 2 |
| `lib/digests/queries.test.ts` | Retype to `DigestRow`, `targets`→`target`, add attribution cases — Task 2 |
| `worker/jobs/digest-tick.ts` | Task 2: flatten groups to keep the template compiling. Task 3: pass `groups` straight through |
| `lib/email/templates/digest.tsx` | Takes `groups`, renders headings, counts distinct reminders — Task 3 |
| `lib/email/templates/digest.test.ts` | 15 existing cases port to the grouped shape — Task 3 |

Task 2 lands the bug fix and stays green with the template untouched; Task 3 is the visual change. Splitting this way means the duplicate-entry fix survives independently if the heading work ever needs reverting.

---

# Task 1: Pure grouping function

Isolated and committable on its own — nothing consumes it yet.

**Files:**
- Create: `lib/digests/group.ts`
- Create: `lib/digests/group.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/digests/group.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { type DigestRow, groupBySystem } from './group';

const HVAC = { id: 'sys_hvac', name: 'HVAC' };
const PLUMBING = { id: 'sys_plumb', name: 'Plumbing' };

const JUN1 = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
const JUN5 = asCalendarDate(new Date('2026-06-05T00:00:00Z'));

function row(over: Partial<DigestRow> = {}): DigestRow {
  return {
    reminderId: 'rem_1',
    title: 'Replace filter',
    dueOn: JUN1,
    daysOverdue: 3,
    target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' },
    system: HVAC,
    ...over,
  };
}

describe('groupBySystem', () => {
  it('returns an empty array for no rows', () => {
    expect(groupBySystem([])).toEqual([]);
  });

  it('collapses several targets of one reminder into a single entry', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_a', name: 'Air Handler' } }),
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual([
      'Air Handler',
      'Furnace',
    ]);
  });

  it('splits one reminder across the systems its targets belong to', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'item', id: 'itm_wh', name: 'Water Heater' }, system: PLUMBING }),
    ]);

    expect(groups.map((g) => g.system?.name)).toEqual(['HVAC', 'Plumbing']);
    // Each heading lists ONLY its own system's targets — no heading ever shows
    // a target belonging to a different system.
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Furnace']);
    expect(groups[1]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Water Heater']);
  });

  it('splits one reminder into separate entries when due dates differ', () => {
    const groups = groupBySystem([
      row({ dueOn: JUN1, daysOverdue: 3, target: { kind: 'item', id: 'a', name: 'Furnace' } }),
      row({ dueOn: JUN5, daysOverdue: 1, target: { kind: 'item', id: 'b', name: 'Attic' } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[0]?.entries.map((e) => e.daysOverdue)).toEqual([3, 1]);
  });

  it('puts rows with no system in an Unassigned group, ordered last', () => {
    const groups = groupBySystem([
      row({ system: null, target: { kind: 'item', id: 'x', name: 'Smoke Alarm' } }),
      row({ system: HVAC }),
    ]);

    expect(groups.map((g) => g.system?.name ?? null)).toEqual(['HVAC', null]);
  });

  it('treats a chore with no target at all as Unassigned', () => {
    const groups = groupBySystem([row({ system: null, target: null })]);
    expect(groups[0]?.system).toBeNull();
    expect(groups[0]?.entries[0]?.targets).toEqual([]);
  });

  it('drops a target that IS the group system, leaving no target line', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'system', id: HVAC.id, name: HVAC.name }, system: HVAC }),
    ]);
    expect(groups[0]?.entries[0]?.targets).toEqual([]);
  });

  // The mixed case targetsArraySchema permits: one reminder targeting both an
  // item AND the system that owns it. A "suppress only when it is the sole
  // target" rule would render "HVAC" as a bullet under the "HVAC" heading.
  it('drops the self-referential system target but keeps the item', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'system', id: HVAC.id, name: HVAC.name }, system: HVAC }),
    ]);

    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Furnace']);
  });

  it('orders systems alphabetically, entries by date then title, targets by name', () => {
    const groups = groupBySystem([
      row({ system: PLUMBING, target: { kind: 'item', id: 'p', name: 'Water Heater' } }),
      row({
        system: HVAC,
        reminderId: 'rem_2',
        title: 'Zebra task',
        dueOn: JUN1,
        target: { kind: 'item', id: 'z', name: 'Zone Valve' },
      }),
      row({
        system: HVAC,
        reminderId: 'rem_3',
        title: 'Apple task',
        dueOn: JUN1,
        target: { kind: 'item', id: 'a2', name: 'Blower' },
      }),
    ]);

    expect(groups.map((g) => g.system?.name)).toEqual(['HVAC', 'Plumbing']);
    expect(groups[0]?.entries.map((e) => e.title)).toEqual(['Apple task', 'Zebra task']);
  });

  it('does not collide two different calendar dates that are equal by value', () => {
    // Two distinct Date objects for the same day must land in the SAME entry.
    // Using the Date object itself as a Map key would make them different keys.
    const a = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
    const b = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
    const groups = groupBySystem([
      row({ dueOn: a, target: { kind: 'item', id: '1', name: 'A' } }),
      row({ dueOn: b, target: { kind: 'item', id: '2', name: 'B' } }),
    ]);
    expect(groups[0]?.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run lib/digests/group.test.ts
```

Expected: FAIL — cannot resolve `./group`.

- [ ] **Step 3: Write the implementation**

Create `lib/digests/group.ts`:

```ts
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

const UNASSIGNED = ' unassigned';

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

    const entryKey = `${r.reminderId} ${r.dueOn.toISOString()}`;
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
      .sort(
        (a, b) =>
          a.dueOn.getTime() - b.dueOn.getTime() || a.title.localeCompare(b.title),
      ),
  }));

  // Systems alphabetical, Unassigned last. Ties break on id: System.name has no
  // uniqueness constraint, so two systems can share a name and ordering must
  // still be deterministic.
  return groups.sort((a, b) => {
    if (a.system === null) return b.system === null ? 0 : 1;
    if (b.system === null) return -1;
    return (
      a.system.name.localeCompare(b.system.name) || a.system.id.localeCompare(b.system.id)
    );
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec vitest run lib/digests/group.test.ts
```

Expected: PASS, all 10 cases.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/digests/group.ts lib/digests/group.test.ts
git commit -m "feat(digests): add pure system-grouping for digest rows"
git log --oneline -1
```

---

# Task 2: Query attribution + collapse duplicates

This commit fixes the duplicate-entry and duplicate-React-key bugs **without touching the template's shape**. `DigestEntry` has the same five fields as the template's existing `DigestItem`, so the worker can flatten groups back into a flat array and the template compiles unchanged.

**Files:**
- Modify: `lib/digests/queries.ts`
- Modify: `lib/digests/queries.test.ts`
- Modify: `worker/jobs/digest-tick.ts`

- [ ] **Step 1: Change the query to resolve system attribution**

In `lib/digests/queries.ts`:

- Delete the local `DigestItem` type; import `DigestRow` from `./group` and make `findAndProject` return `Promise<DigestRow[]>` (as do `getOverdueForUser` / `getWeeklyForUser`).
- Add the nested system select:

```ts
    include: {
      reminder: { select: { id: true, title: true } },
      item: {
        select: {
          id: true,
          name: true,
          system: { select: { id: true, name: true } },
        },
      },
      system: { select: { id: true, name: true } },
    },
```

- Replace the `.map()` body's return with a singular target plus resolved system:

```ts
  return targets.map((t) => {
    const target =
      t.item != null
        ? { kind: 'item' as const, id: t.item.id, name: t.item.name }
        : t.system != null
          ? { kind: 'system' as const, id: t.system.id, name: t.system.name }
          : null;
    // A system-targeted row attributes to itself; an item-targeted row to its
    // parent; anything else is Unassigned.
    const system = t.system ?? t.item?.system ?? null;
    return {
      reminderId: t.reminder.id,
      title: t.reminder.title,
      dueOn: t.nextDueOn,
      daysOverdue: Math.max(0, daysBetween(today, t.nextDueOn)),
      target,
      system,
    };
  });
```

**Leave `const today = startOfDayUtc(now, timezone);` and the comment above it exactly as they are.** That is the one legitimate timezone use in this file.

- [ ] **Step 2: Update the query's own test file**

`lib/digests/queries.test.ts:7` imports `type DigestItem from './queries'`, and `:13`/`:14` type the two harness variables as `Promise<DigestItem[]>`. Deleting `DigestItem` in Step 1 breaks all three. Change the import to:

```ts
import type { DigestRow } from './group';
```

and retype both declarations to `Promise<DigestRow[]>`.

Existing assertions on `rows[0]?.targets` become `rows[0]?.target` (singular). **Do not touch the timezone, overdue-cutoff, Tokyo or weekly-window cases** — only the type and the `targets` → `target` rename.

Then add the attribution cases, which are the only part that genuinely needs a database:

```ts
// - An item-targeted row picks up item.system as `system`.
// - A system-targeted row attributes to itself (system.id === the system's id).
// - An item whose systemId is null yields `system: null`.
```

- [ ] **Step 3: Wire the worker, flattening groups back to a flat array**

This is what keeps the tree green without touching the template. `DigestEntry` has the same five fields as the template's existing `DigestItem`, so flattening produces exactly what `digestEmail` already accepts — while the grouping has already collapsed the duplicate rows.

In `worker/jobs/digest-tick.ts`, add the import:

```ts
import { groupBySystem } from '@/lib/digests/group';
```

and change `:49`:

```ts
  const rows =
    kind === 'overdue'
      ? await getOverdueForUser(userId, timezone)
      : await getWeeklyForUser(userId, timezone);
  // Task 3 replaces this flatMap with passing `groups` straight through.
  const items = groupBySystem(rows).flatMap((g) => g.entries);
```

`:53`'s `if (items.length === 0)` and `:63`'s `digestEmail({ mode: kind, items, appUrl })` are unchanged.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck
pnpm exec vitest run lib/digests lib/email
docker compose up -d db meilisearch
pnpm exec vitest run lib/digests/queries.test.ts
```

Expected: all PASS.

Note what proves what. `digest.test.ts` builds its fixtures by hand and never imports `queries.ts`, `group.ts` or the worker — so it **cannot** observe the flatMap, and its 15 cases would pass either way. A wrong flatMap shape surfaces as a **`pnpm typecheck` failure**, which is why typecheck is first in this list. The template tests are here only to confirm nothing else regressed.

- [ ] **Step 5: Commit**

```bash
git add lib/digests worker/jobs/digest-tick.ts
git commit -m "fix(digests): collapse a reminder's targets into one digest entry"
git log --oneline -1
```

---

# Task 3: Render system headings

Now the visual change, on top of a tree that already has the bug fixed.

**Files:**
- Modify: `lib/email/templates/digest.tsx`
- Modify: `lib/email/templates/digest.test.ts`
- Modify: `worker/jobs/digest-tick.ts`

- [ ] **Step 1: Change the template's input shape**

In `lib/email/templates/digest.tsx`:

- Delete the local `DigestItemTarget` (`:9`) and `DigestItem` (`:13`) types. Import instead:

```ts
import type { DigestEntry, DigestGroup, DigestTarget } from '@/lib/digests/group';
```

- Change `DigestEmailData`:

```ts
export type DigestEmailData = {
  mode: 'overdue' | 'weekly';
  groups: DigestGroup[]; // template never re-sorts; group.ts owns order
  appUrl: string;
};
```

- `targetHref` (`:43`) takes `DigestTarget`; its body is unchanged.

- [ ] **Step 2: Render headings in the HTML body**

Replace the `<ul>` block at `digest.tsx:62-87` with a section per group. The existing `<a>` + `<div>` inside the `<li>` are unchanged:

```tsx
      {data.groups.map((g) => (
        <section key={g.system?.id ?? 'unassigned'} style={{ marginTop: '20px' }}>
          <h2
            style={{
              margin: '0 0 4px 0',
              fontSize: '15px',
              lineHeight: 1.3,
              color: T.ink,
              fontWeight: 600,
            }}
          >
            {g.system?.name ?? 'Unassigned'}
          </h2>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {g.entries.map((it) => (
              <li
                key={`${it.reminderId}-${it.dueOn.toISOString()}`}
                style={{ borderTop: `1px solid ${T.line}`, padding: '12px 0' }}
              >
                {/* existing <a href=.../reminders/...> and <div> body, unchanged */}
              </li>
            ))}
          </ul>
        </section>
      ))}
```

The key **must** include `dueOn`. A reminder split across two due dates yields two entries in the same group sharing a `reminderId`, and keying on `reminderId` alone would reintroduce the duplicate-key bug this work exists to fix.

- [ ] **Step 3: Rewrite `buildText` with headings**

Replace `buildText` (`digest.tsx:92-109`) entirely:

```ts
function buildText(data: DigestEmailData): string {
  const lines: string[] = [];
  lines.push(data.mode === 'overdue' ? 'Overdue reminders' : 'Reminders due this week');
  lines.push('');
  for (const g of data.groups) {
    lines.push(g.system?.name ?? 'Unassigned');
    for (const it of g.entries) {
      const badge =
        data.mode === 'overdue' ? `${it.daysOverdue}d overdue` : `due ${formatDue(it.dueOn)}`;
      const targetNames = it.targets.map((t) => t.name).join(', ');
      lines.push(`  - ${it.title}${targetNames ? ` (${targetNames})` : ''} — ${badge}`);
      lines.push(`    ${data.appUrl}/reminders/${it.reminderId}`);
      for (const t of it.targets) {
        lines.push(`    ${targetHref(t, data.appUrl)}`);
      }
      lines.push('');
    }
  }
  lines.push(`Manage notification settings: ${data.appUrl}/settings`);
  return lines.join('\n');
}
```

System name flush left, entries indented two, URLs four. Keep the em dash `—` before the badge — that is what the current code emits.

- [ ] **Step 4: Count distinct reminders in the subject**

Replace `digest.tsx:120`:

```ts
  const count = new Set(
    normalized.groups.flatMap((g) => g.entries.map((e) => e.reminderId)),
  ).size;
```

Not `groups.length`, and not the sum of `entries.length`: a cross-system reminder appears in two groups, and a date-split reminder appears twice within one group. Both must count once.

Also change the empty guard to `data.groups.length === 0`.

- [ ] **Step 5: Simplify the worker**

Remove the Task 2 flatMap; pass groups straight through:

```ts
  const groups = groupBySystem(rows);
  if (groups.length === 0) {
    // ...existing skip branch unchanged...
  }
```

and

```ts
  const { subject, html, text } = digestEmail({ mode: kind, groups, appUrl });
```

- [ ] **Step 6: Port the template tests**

`lib/email/templates/digest.test.ts` has 15 cases on two factories. Add the import and rework the factories — that is most of the work:

```ts
import type { DigestEntry, DigestGroup } from '@/lib/digests/group';

function baseEntry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    reminderId: 'rem_1',
    title: 'Replace filter',
    dueOn: asCalendarDate(new Date('2026-06-01T00:00:00Z')),
    daysOverdue: 0,
    targets: [{ kind: 'item' as const, id: 'itm_1', name: 'Furnace' }],
    ...over,
  };
}

function baseGroup(over: Partial<DigestGroup> = {}): DigestGroup {
  return { system: { id: 'sys_1', name: 'HVAC' }, entries: [baseEntry()], ...over };
}

function baseData(over: Partial<DigestEmailData> = {}): DigestEmailData {
  return {
    mode: 'overdue',
    groups: [baseGroup({ entries: [baseEntry({ daysOverdue: 3 })] })],
    appUrl: 'https://hm.example',
    ...over,
  };
}
```

Typing `baseEntry` as `DigestEntry` (rather than an indexed-access type) is deliberate: it makes the `DigestEntry` export genuinely consumed, so `lint:knip` does not flag it as unused.

Then add cases for the new behaviour:

```ts
// - The system name renders as a heading in BOTH html and text.
// - A null-system group renders the literal heading "Unassigned" in both.
// - Subject counts distinct reminders: the same reminderId across two groups
//   yields "1 reminder", not "2 reminders".
// - Subject counts distinct reminders: the same reminderId twice in ONE group
//   (two due dates) also yields "1 reminder".
// - An entry with an empty `targets` array renders no target list and no
//   separator dot — just the badge.
```

- [ ] **Step 7: Verify**

```bash
pnpm typecheck
pnpm exec vitest run lib/digests lib/email
DATABASE_URL="postgresql://knip:knip@localhost:5432/knip" pnpm lint
```

Expected: all PASS, including knip (which is what catches an unused `DigestEntry`).

- [ ] **Step 8: Commit**

```bash
git add lib/email/templates worker/jobs/digest-tick.ts
git commit -m "feat(digests): render digest emails grouped by system"
git log --oneline -1
```

---

# Task 4: Full verification and PR

- [ ] **Step 1: Run the full local gate**

```bash
pnpm verify
```

Expected: lint + typecheck + unit all pass. `pnpm lint` needs `DATABASE_URL` set for knip — the pre-push hook supplies a dummy, so locally use:

```bash
DATABASE_URL="postgresql://knip:knip@localhost:5432/knip" pnpm lint
```

- [ ] **Step 2: Run the integration suite**

```bash
pnpm test:integration
```

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/digest-system-grouping
gh pr create --fill
```

Then per this repo's workflow: watch **strictly** the "Sourcery review" check; if it runs, address its comments first. Then `gh pr merge --auto --squash`, then `gh pr checks --watch --fail-fast`. Run both watches in the background.

**Push from a checkout of this branch.** The pre-push hook lints the *working tree*, not the ref being pushed — pushing this branch while checked out on another one runs knip against the wrong code.

---

## Deferred — do not build

- Grouping in the in-app calendar or dashboard views. Email only.
- Any change to digest scheduling, `DigestLog` dedup, or the `queued`→`sent` transition.
- Disambiguating two systems that share a name. Grouping is by id so they stay correctly separate; they will render as two identical headings, which is accepted.
- Filtering chores out of digests. Their inclusion is deliberate (`CLAUDE.md`).
