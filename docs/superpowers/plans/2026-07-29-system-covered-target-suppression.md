# System-Covered Target Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reminder and digest emails from listing item targets whose parent system the same reminder already targets, and collapse duplicate calendar dots for the same reminder on the same day.

**Architecture:** One pure rule (`lib/reminders/target-coverage.ts`) consumed by three renderers that each map their own row shape into a shared `CoverageFacts` projection. The in-app chip renderer already implements this rule inline; it is refactored to delegate, so there is exactly one definition. The calendar fix is a separate, simpler pure function.

**Tech Stack:** TypeScript 7, Vitest 4, React server components, Prisma 7. Package manager is **pnpm** — never `npx`/`npm`.

**Spec:** `docs/superpowers/specs/2026-07-29-system-covered-target-suppression-design.md`

---

## Before you start

Read these first — they carry constraints that are not obvious from the code:

- `CLAUDE.md` § "Calendar dates are not instants". Every date in this plan
  (`nextDueOn`, `dueOn`, `CalendarEvent.date`) is a `@db.Date` calendar date
  pinned to UTC midnight. **Never pass one through a timezone.** Comparison is
  plain `getTime()` equality; formatting is `formatCalendarDate`.
- `CLAUDE.md` § "`pnpm lint` is three tools". `lint:knip` runs on pre-push and
  will flag an exported symbol nothing imports.
- Never use `--no-verify`. `git commit` can fail *silently* behind the Biome
  pre-commit hook — after every commit step, confirm `git log --oneline -1`
  actually moved.

Branch is already `fix/system-covered-target-suppression` with the spec
committed. Work continues on it.

## File Structure

| File | Responsibility |
|---|---|
| `lib/reminders/target-coverage.ts` **(create)** | The single definition of "this item target is covered by a system target". Pure, no Prisma, no React. |
| `lib/reminders/target-coverage.test.ts` **(create)** | Unit tests for the rule in isolation. |
| `components/targets/TargetsChips.tsx` **(modify)** | Delegates its inline dedupe to the shared rule. No behavior change. |
| `worker/jobs/notify.ts` **(modify)** | Loads `item.systemId` so the fact reaches the template. |
| `lib/email/templates/reminder.tsx` **(modify)** | Filters targets before rendering HTML and text. |
| `lib/email/templates/reminder.test.ts` **(modify)** | Covers the six-target HVAC case and date drift. |
| `lib/digests/group.ts` **(modify)** | Buffers rows per entry, applies the rule, then drops the own-system target. |
| `lib/digests/group.test.ts` **(modify)** | One existing assertion is **inverted**; new cases added. |
| `lib/calendar/collapse.ts` **(create)** | Collapses duplicate `(kind, id, date)` calendar events. |
| `lib/calendar/collapse.test.ts` **(create)** | Unit tests for the collapse. |
| `lib/calendar/queries.ts` **(modify)** | Applies the collapse; stale comment rewritten. |
| `components/calendar/MonthGrid.tsx` **(untouched)** | Listed only to be explicit: its `` `${ev.kind}:${ev.id}` `` React key is fixed by the collapse upstream. Do not change the key. |

---

### Task 1: The shared coverage rule

**Files:**
- Create: `lib/reminders/target-coverage.ts`
- Test: `lib/reminders/target-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/reminders/target-coverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { type CoverageFacts, dropSystemCoveredItems } from './target-coverage';

const JUN1 = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
const JUN8 = asCalendarDate(new Date('2026-06-08T00:00:00Z'));

/** A minimal row shape standing in for the three real ones. */
type Row = { name: string } & CoverageFacts;

const facts = (r: Row): CoverageFacts => ({
  systemId: r.systemId,
  itemSystemId: r.itemSystemId,
  dueOn: r.dueOn,
});

const names = (rows: Row[]) => dropSystemCoveredItems(rows, facts).map((r) => r.name);

describe('dropSystemCoveredItems', () => {
  it('returns an empty array for no targets', () => {
    expect(dropSystemCoveredItems([], facts)).toEqual([]);
  });

  it('hides an item whose parent system is also targeted', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
      ]),
    ).toEqual(['HVAC']);
  });

  it('keeps an item whose parent system is NOT targeted', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'Plumbing', systemId: 'plumb', itemSystemId: null },
      ]),
    ).toEqual(['Furnace', 'Plumbing']);
  });

  it('keeps an unassigned item (no parent system at all)', () => {
    expect(
      names([
        { name: 'Fridge', systemId: null, itemSystemId: null },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
      ]),
    ).toEqual(['Fridge', 'HVAC']);
  });

  it('never hides a system target', () => {
    expect(
      names([
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
        { name: 'HVAC again', systemId: 'hvac', itemSystemId: null },
      ]),
    ).toEqual(['HVAC', 'HVAC again']);
  });

  it('keeps a covered item when the due dates disagree', () => {
    // The furnace filter drifted a week past its system's date. Hiding it
    // would make an actionable target invisible until the system came due.
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac', dueOn: JUN8 },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null, dueOn: JUN1 },
      ]),
    ).toEqual(['Furnace', 'HVAC']);
  });

  it('hides a covered item when the due dates match', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac', dueOn: JUN1 },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null, dueOn: JUN1 },
      ]),
    ).toEqual(['HVAC']);
  });

  it('treats an omitted dueOn as agreeing (the TargetsChips call shape)', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null, dueOn: JUN1 },
      ]),
    ).toEqual(['HVAC']);
  });

  it('preserves input order among survivors', () => {
    expect(
      names([
        { name: 'Fridge', systemId: null, itemSystemId: null },
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
        { name: 'Attic Fan', systemId: null, itemSystemId: null },
      ]),
    ).toEqual(['Fridge', 'HVAC', 'Attic Fan']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec vitest run lib/reminders/target-coverage.test.ts
```

Expected: FAIL — cannot resolve `./target-coverage`.

- [ ] **Step 3: Write the implementation**

Create `lib/reminders/target-coverage.ts`:

```ts
import type { CalendarDate } from '@/lib/time/tz';

/**
 * "Naming the system already says everything the component rows say."
 *
 * A reminder may legitimately target both a System and the Items that belong to
 * it — `targetsArraySchema` allows the array, and the XOR check constraint is
 * per-target, not per-reminder. Rendering all of them repeats the same fact
 * once per component. This module is the single definition of which item
 * targets that makes redundant.
 *
 * It is deliberately shape-agnostic: the reminder email, the digest grouper and
 * <TargetsChips> each hold a different row type, and each projects into
 * `CoverageFacts` rather than converging on a common row.
 */
export type CoverageFacts = {
  /** id of the System this target *is*; null for item targets. */
  systemId: string | null;
  /**
   * id of the System owning the Item this target *is*. Null when the target is
   * a system, or when the item belongs to no system.
   */
  itemSystemId: string | null;
  /**
   * This target's own due date. Omit to skip the date check entirely — callers
   * with no date context (<TargetsChips>) and callers whose scope already
   * guarantees one shared date (digest entries) both leave it undefined.
   */
  dueOn?: CalendarDate;
};

/**
 * Calendar dates are stored at UTC midnight, so equality is exact `getTime()`
 * comparison — no timezone is involved. See `lib/time/tz.ts`.
 *
 * An omitted date on *either* side agrees with anything: absence means "this
 * caller is not making a claim about dates", not "this target has no date".
 */
function datesAgree(a: CalendarDate | undefined, b: CalendarDate | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a.getTime() === b.getTime();
}

/**
 * Drop item targets whose parent system is also targeted on the same day.
 *
 * System targets are never candidates for removal, so any suppression implies a
 * surviving system target — this can never empty a non-empty list.
 */
export function dropSystemCoveredItems<T>(
  targets: readonly T[],
  facts: (target: T) => CoverageFacts,
): T[] {
  const read = targets.map((target) => ({ target, facts: facts(target) }));
  return read
    .filter(({ facts: f }) => {
      // Not an item target, or an item belonging to no system: nothing can cover it.
      if (f.itemSystemId === null) return true;
      return !read.some(
        ({ facts: other }) =>
          other.systemId !== null &&
          other.systemId === f.itemSystemId &&
          datesAgree(f.dueOn, other.dueOn),
      );
    })
    .map(({ target }) => target);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec vitest run lib/reminders/target-coverage.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Verify each rule is load-bearing**

Do not skip this. PR #311 shipped two tests that passed with the rule under test
deleted. For each of these, make the edit, confirm the named test goes **red**,
then revert:

| Temporary edit to `target-coverage.ts` | Must turn red |
|---|---|
| `datesAgree` → `return true` always | "keeps a covered item when the due dates disagree" |
| `other.systemId === f.itemSystemId` → `other.systemId !== null` | "keeps an item whose parent system is NOT targeted" |
| `other.systemId === f.itemSystemId` → `other.systemId === f.systemId` | "hides an item whose parent system is also targeted" |

Note the `if (f.itemSystemId === null) return true` early return is deliberately
**not** in that table: it cannot be falsified. Remove it and unassigned items
still survive, because the inner predicate requires
`other.systemId === f.itemSystemId` and a non-null id never equals `null`. It is
a readability short-circuit, not a rule. Don't go hunting for a test it breaks.

- [ ] **Step 6: Commit**

```bash
git add lib/reminders/target-coverage.ts lib/reminders/target-coverage.test.ts
git commit -m "feat(reminders): pure rule for system-covered item targets"
git log --oneline -1
```

---

### Task 2: TargetsChips delegates to the shared rule

Pure refactor. `components/targets/TargetsChips.test.tsx` must stay green **with
no edits** — that is the proof the extraction preserved semantics. Its existing
cases at lines 84 and 131 already cover both directions of the rule.

**Files:**
- Modify: `components/targets/TargetsChips.tsx:34-64`
- Test: `components/targets/TargetsChips.test.tsx` (unchanged)

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

```bash
pnpm exec vitest run components/targets/TargetsChips.test.tsx
```

Expected: PASS. Note the count; it must be identical afterward.

- [ ] **Step 2: Replace `resolve()`**

In `components/targets/TargetsChips.tsx`, add the import:

```ts
import { dropSystemCoveredItems } from '@/lib/reminders/target-coverage';
```

Replace the whole `resolve` function (currently lines 34-64) with:

```ts
function resolve(targets: TargetSummary[]): Resolved[] {
  // No `dueOn`: chips carry no date context, so coverage is decided on
  // parentage alone — the same rule this component used inline before it moved
  // to lib/reminders/target-coverage.ts.
  const visible = dropSystemCoveredItems(targets, (t) => ({
    systemId: t.system?.id ?? null,
    itemSystemId: t.system ? null : (t.item?.systemId ?? null),
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
```

The `t.system ? null : …` guard keeps the XOR reading: a system target never
reports an `itemSystemId`, even if the row somehow carried both.

- [ ] **Step 3: Run the tests**

```bash
pnpm exec vitest run components/targets/TargetsChips.test.tsx
```

Expected: PASS with the same test count as Step 1, and **zero edits** to the
test file. If a test went red, the extraction changed behavior — fix
`target-coverage.ts`, not the test.

- [ ] **Step 4: Commit**

```bash
git add components/targets/TargetsChips.tsx
git commit -m "refactor(targets): delegate chip dedupe to the shared coverage rule"
git log --oneline -1
```

---

### Task 3: Reminder email

**Files:**
- Modify: `worker/jobs/notify.ts:33`
- Modify: `lib/email/templates/reminder.tsx:9-13,43-68`
- Test: `lib/email/templates/reminder.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('reminderEmail', …)` block in
`lib/email/templates/reminder.test.ts`:

```ts
  it('hides item targets whose parent system is also targeted', () => {
    // The reported bug: one reminder, two HVAC systems, four component items.
    // Six lines arrive; two should.
    const { html, text } = reminderEmail(
      baseData({
        title: 'HVAC Filters',
        targets: [
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            item: { id: 'itm_df', name: 'Downstairs Furnace', systemId: 'sys_down' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            system: { id: 'sys_down', name: 'Downstairs HVAC' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            item: { id: 'itm_dhp', name: 'Downstairs Heat Pump', systemId: 'sys_down' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            system: { id: 'sys_up', name: 'Upstairs HVAC' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            item: { id: 'itm_uf', name: 'Upstairs Furnace', systemId: 'sys_up' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            item: { id: 'itm_uhp', name: 'Upstairs Heat Pump', systemId: 'sys_up' },
          },
        ],
      }),
    );

    for (const body of [html, text]) {
      expect(body).toContain('Downstairs HVAC');
      expect(body).toContain('Upstairs HVAC');
      expect(body).not.toContain('Downstairs Furnace');
      expect(body).not.toContain('Downstairs Heat Pump');
      expect(body).not.toContain('Upstairs Furnace');
      expect(body).not.toContain('Upstairs Heat Pump');
    }
    // Exactly two bullets survive.
    expect(html.match(/<li/g) ?? []).toHaveLength(2);
  });

  it('keeps an item target whose parent system is not targeted', () => {
    const { html } = reminderEmail(
      baseData({
        targets: [
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            item: { id: 'itm_uf', name: 'Upstairs Furnace', systemId: 'sys_up' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            system: { id: 'sys_plumb', name: 'Plumbing' },
          },
        ],
      }),
    );
    expect(html).toContain('Upstairs Furnace');
    expect(html).toContain('Plumbing');
  });

  it('keeps a covered item target whose due date has drifted', () => {
    // Completed late, so this target advanced independently of its system.
    // Hiding it would make an overdue filter invisible.
    const { html } = reminderEmail(
      baseData({
        targets: [
          {
            nextDueOn: asCalendarDate(new Date('2026-08-08T00:00:00Z')),
            item: { id: 'itm_uf', name: 'Upstairs Furnace', systemId: 'sys_up' },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            system: { id: 'sys_up', name: 'Upstairs HVAC' },
          },
        ],
      }),
    );
    expect(html).toContain('Upstairs Furnace');
    expect(html).toContain('Upstairs HVAC');
  });

  it('keeps an item target that belongs to no system', () => {
    const { html } = reminderEmail(
      baseData({
        targets: [
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            item: { id: 'itm_fridge', name: 'Fridge', systemId: null },
          },
          {
            nextDueOn: asCalendarDate(new Date('2026-08-01T00:00:00Z')),
            system: { id: 'sys_up', name: 'Upstairs HVAC' },
          },
        ],
      }),
    );
    expect(html).toContain('Fridge');
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm exec vitest run lib/email/templates/reminder.test.ts
```

Expected: the first test FAILS — all six names present, 6 `<li>`. The fixture's
`systemId` is also a type error until Step 3 widens `ReminderEmailTarget`;
Vitest still runs the test, so the assertion failure is what you should see.

- [ ] **Step 3: Implement**

In `lib/email/templates/reminder.tsx`, add the import:

```ts
import { dropSystemCoveredItems } from '@/lib/reminders/target-coverage';
```

Widen the target type (line 9-13):

```ts
type ReminderEmailTarget = {
  nextDueOn: CalendarDate;
  /** `systemId` is the item's parent system — it drives coverage suppression. */
  item?: { id: string; name: string; systemId?: string | null };
  system?: { id: string; name: string };
};
```

Filter inside `resolveTargets` (line 43), leaving the `.map` body untouched:

```ts
function resolveTargets(data: ReminderEmailData): ResolvedTarget[] {
  // An item target is noise when the same reminder also targets the system that
  // owns it *on the same day* — the system's line already covers it. Dates must
  // agree: per-target completion lets a component drift away from its system,
  // and a drifted target is exactly the one worth still seeing.
  const visible = dropSystemCoveredItems(data.targets, (t) => ({
    systemId: t.system?.id ?? null,
    itemSystemId: t.item?.systemId ?? null,
    dueOn: t.nextDueOn,
  }));

  return visible.map((t) => {
    // ...existing body unchanged...
  });
}
```

Both `Body` and `buildText` call `resolveTargets`, so HTML and plaintext stay in
sync with no second edit.

Do **not** write `itemSystemId: t.system ? null : (t.item?.systemId ?? null)`.
That guard is unobservable: `dropSystemCoveredItems` short-circuits on
`f.systemId !== null` before reading `itemSystemId`, and its inner `some` reads
only `other.systemId`. It was removed from `TargetsChips` in Task 2 for exactly
this reason. (Task 4's `kind`-based guard is *not* the same thing and must
stay — see that task.)

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm exec vitest run lib/email/templates/reminder.test.ts
```

Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Load the fact in the worker**

`worker/jobs/notify.ts` line 33 — without this the template's new field is
always `undefined` in production and the filter silently never fires:

```ts
        item: { select: { id: true, name: true, systemId: true } },
```

- [ ] **Step 6: Fix two comments that this task makes wrong**

Both name `<TargetsChips>` as the *reason* a field exists. As of this task the
rule has a second consumer, so naming one component is now misleading. Reword to
name the rule instead.

`lib/reminders/queries.ts:9-11`, above `item: { select: { …, systemId: true } }`
in `TARGETS_INCLUDE`:

```ts
      // `item.systemId` feeds `dropSystemCoveredItems`
      // (lib/reminders/target-coverage.ts), which hides item targets whose
      // parent system is targeted by the same reminder.
```

`components/targets/TargetsChips.tsx:8-13`, the doc on `TargetSummary.item`:
reword "lets the chip renderer dedupe item chips that belong to a system already
in the same target set" to attribute the dedupe to `dropSystemCoveredItems`
rather than to the chip renderer, which now only supplies facts to it.

- [ ] **Step 7: Typecheck**

```bash
pnpm typecheck
```

Expected: clean. This is the step that catches the worker/template shapes
disagreeing.

- [ ] **Step 8: Commit**

```bash
git add worker/jobs/notify.ts lib/email/templates/reminder.tsx lib/email/templates/reminder.test.ts lib/reminders/queries.ts components/targets/TargetsChips.tsx
git commit -m "fix(email): hide reminder targets covered by a targeted system"
git log --oneline -1
```

---

### Task 4: Digest email

> ⚠️ **One existing test asserts the old behavior and must be inverted.**
> `lib/digests/group.test.ts:88` — *"drops the self-referential system target but
> keeps the item"* — will go red. That is the intended outcome, not a
> regression. Rewrite it (Step 1) rather than weakening the implementation.

**Files:**
- Modify: `lib/digests/group.ts:49-108`
- Test: `lib/digests/group.test.ts`

- [ ] **Step 1: Invert the stale test and add new cases**

In `lib/digests/group.test.ts`, replace the existing test at line 88 (and the
three-line comment above it that defends the old rule) with:

```ts
  // The mixed case targetsArraySchema permits: one reminder targeting both an
  // item AND the system that owns it. Under the "HVAC" heading, "Furnace" adds
  // nothing the heading has not already said — the system covers its items.
  it('drops both the self-referential system target and the items it covers', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'system', id: HVAC.id, name: HVAC.name }, system: HVAC }),
    ]);

    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.targets).toEqual([]);
  });

  it('keeps items when the entry carries no system target of its own', () => {
    // Nothing covers them: the heading is attribution, not a target.
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'item', id: 'itm_hp', name: 'Heat Pump' }, system: HVAC }),
    ]);

    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Furnace', 'Heat Pump']);
  });

  it('keeps a covered item whose due date drifted from its system target', () => {
    // Different dueOn => different entry => no system target in scope to cover
    // it. The date rule holds here without any date comparison.
    const groups = groupBySystem([
      row({ dueOn: JUN5, target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' } }),
      row({ dueOn: JUN1, target: { kind: 'system', id: HVAC.id, name: HVAC.name } }),
    ]);

    expect(groups[0]?.entries).toHaveLength(2);
    const jun5 = groups[0]?.entries.find((e) => e.dueOn.getTime() === JUN5.getTime());
    expect(jun5?.targets.map((t) => t.name)).toEqual(['Furnace']);
  });

  it('leaves the Unassigned group alone', () => {
    // system === null, so no item there has a parent that could cover it.
    const groups = groupBySystem([
      row({ system: null, target: { kind: 'item', id: 'itm_fridge', name: 'Fridge' } }),
    ]);

    expect(groups[0]?.system).toBeNull();
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Fridge']);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm exec vitest run lib/digests/group.test.ts
```

Expected: **only** the inverted test fails (its targets still contain
`Furnace`). The other three — drift, "keeps items", "Unassigned" — already pass
against the current implementation, and that is the point: they pin behavior
that must *not* change when `groupBySystem` is rewritten wholesale in Step 3.

The drift test in particular passes today because the two rows carry different
`dueOn` values and therefore already land in separate entries. It is a
regression pin, not a red-then-green step.

- [ ] **Step 3: Restructure `groupBySystem` to buffer rows**

In `lib/digests/group.ts`, add the import:

```ts
import { dropSystemCoveredItems } from '@/lib/reminders/target-coverage';
```

Add this helper above `groupBySystem`:

```ts
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
 */
function projectTargets(entryRows: readonly DigestRow[]): DigestTarget[] {
  const visible = dropSystemCoveredItems(entryRows, (r) => ({
    systemId: r.target?.kind === 'system' ? r.target.id : null,
    itemSystemId: r.target?.kind === 'item' ? (r.system?.id ?? null) : null,
  }));

  const out: DigestTarget[] = [];
  for (const r of visible) {
    if (r.target === null) continue; // standalone chore: no target at all
    // Drop a target that IS this group's system — the heading already names it.
    if (r.target.kind === 'system' && r.target.id === r.system?.id) continue;
    out.push(r.target);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
```

Then rewrite `groupBySystem` to buffer rows per entry instead of pushing
targets as it goes:

```ts
export function groupBySystem(rows: readonly DigestRow[]): DigestGroup[] {
  const bySystem = new Map<
    string,
    {
      system: DigestGroup['system'];
      entries: Map<string, { entry: DigestEntry; rows: DigestRow[] }>;
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
          targets: [],
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
```

Keep the existing `UNASSIGNED` const and the doc comment on `groupBySystem`.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm exec vitest run lib/digests/group.test.ts
```

Expected: PASS, all tests including the pre-existing ordering and
cross-system cases.

- [ ] **Step 5: Confirm the digest template tolerates empty target lists**

```bash
pnpm exec vitest run lib/email/templates/digest.test.ts
```

Expected: PASS unchanged. `digest.tsx:89` (`it.targets.length > 0 ? ' · ' : ''`)
and the `targetNames ? …` guard in `buildText` both already handle it — the
entry renders as title + due date with **no `·` separator**.

- [ ] **Step 6: Commit**

```bash
git add lib/digests/group.ts lib/digests/group.test.ts
git commit -m "fix(digests): hide item targets covered by a targeted system"
git log --oneline -1
```

---

### Task 5: Calendar grid duplicate collapse

Different rule, same annoyance: six targets due August 1 render six identical
"HVAC Filters" dots. The events carry no target name, so the repetition conveys
nothing — and since `CalendarEvent.id` is `reminder.id` and
`components/calendar/MonthGrid.tsx:90` keys on `` `${ev.kind}:${ev.id}` ``, those
six siblings currently share one React key.

**Files:**
- Create: `lib/calendar/collapse.ts`
- Create: `lib/calendar/collapse.test.ts`
- Modify: `lib/calendar/queries.ts:32-34,51-68`

- [ ] **Step 1: Write the failing test**

Create `lib/calendar/collapse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collapseDuplicateReminderEvents } from './collapse';

const AUG1 = new Date('2026-08-01T00:00:00Z');
const AUG2 = new Date('2026-08-02T00:00:00Z');

const ev = (kind: string, id: string, date: Date) => ({ kind, id, date });

describe('collapseDuplicateReminderEvents', () => {
  it('returns an empty array for no events', () => {
    expect(collapseDuplicateReminderEvents([])).toEqual([]);
  });

  it('collapses one reminder appearing once per target on the same day', () => {
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the same reminder on two different days', () => {
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG2),
    ]);
    expect(out.map((e) => e.date)).toEqual([AUG1, AUG2]);
  });

  it('keeps distinct reminders on the same day', () => {
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_gutters', AUG1),
    ]);
    expect(out.map((e) => e.id)).toEqual(['rem_hvac', 'rem_gutters']);
  });

  it('does not let a service record collide with a reminder sharing its id', () => {
    // Distinct id spaces in practice; keyed on `kind` so that stays structural.
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'shared_id', AUG1),
      ev('service', 'shared_id', AUG1),
    ]);
    expect(out).toHaveLength(2);
  });

  it('is keep-first and order-preserving', () => {
    const first = ev('reminder', 'rem_hvac', AUG1);
    const out = collapseDuplicateReminderEvents([
      first,
      ev('service', 'svc_1', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(first);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec vitest run lib/calendar/collapse.test.ts
```

Expected: FAIL — cannot resolve `./collapse`.

- [ ] **Step 3: Write the implementation**

Create `lib/calendar/collapse.ts`:

```ts
/**
 * Reminder due-state lives on `ReminderTarget`, so a reminder targeting six
 * things due on one day projects six identical calendar events — the events
 * carry no target name, so the repetition says nothing six times. It also
 * emitted six React siblings sharing one key, since `CalendarEvent.id` is the
 * reminder id.
 *
 * Generic over the event shape rather than importing `CalendarEvent`: that
 * avoids a type cycle with `queries.ts`, which imports this module.
 */
export function collapseDuplicateReminderEvents<
  T extends { kind: string; id: string; date: Date },
>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ev of events) {
    // Space-joined, matching the convention in lib/digests/group.ts: `kind` is
    // a fixed lowercase word, ids are cuid ([0-9a-z]) and toISOString() is
    // fixed-format, so no part can contain the separator. `date` is a calendar
    // date at UTC midnight, so its ISO string is a stable per-day key.
    const key = `${ev.kind} ${ev.id} ${ev.date.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm exec vitest run lib/calendar/collapse.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the query**

In `lib/calendar/queries.ts`, add the import:

```ts
import { collapseDuplicateReminderEvents } from './collapse';
```

Replace the stale comment above the `Promise.all` (lines 32-34) with:

```ts
  // `nextDueOn` lives on ReminderTarget — multiple targets on one reminder can
  // be due on different days, so each target is projected as its own event and
  // duplicates within a day are collapsed below. A reminder spanning 3 items
  // due on 3 days is 3 dots; the same 3 items due on one day is 1 dot.
```

Then wrap the event assembly (lines 51-68):

```ts
  const events: CalendarEvent[] = collapseDuplicateReminderEvents([
    ...targets.map(
      (t): CalendarEvent => ({
        kind: 'reminder' as const,
        id: t.reminder.id,
        title: t.reminder.title,
        date: t.nextDueOn,
      }),
    ),
    ...services.map(
      (s): CalendarEvent => ({
        kind: 'service' as const,
        id: s.id,
        title: s.summary,
        date: s.performedOn,
      }),
    ),
  ]);
  events.sort((a, b) => a.date.getTime() - b.date.getTime());
  return events;
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add lib/calendar/collapse.ts lib/calendar/collapse.test.ts lib/calendar/queries.ts
git commit -m "fix(calendar): collapse duplicate dots for one reminder on one day"
git log --oneline -1
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the full pre-push gate**

```bash
pnpm verify
```

Expected: lint + typecheck + unit all clean.

`CoverageFacts` is referenced only from `target-coverage.test.ts`. Knip's vitest
plugin treats test files as entries, so this should pass — but if it does trip,
the fix is to use the type at a real call site (annotate the projection lambdas'
return type), **not** to widen `knip.json`. Same for
`collapseDuplicateReminderEvents`: if knip calls it unused, a call site was
missed.

- [ ] **Step 2: Run the integration suite**

Requires infra: `docker compose up -d db meilisearch`.

```bash
pnpm test:integration
```

Pay attention to `tests/integration/notify-job.test.ts`,
`tests/integration/digest-tick.test.ts` and
`tests/integration/reminder-multi-target.test.ts` — those exercise the changed
paths end to end. A failure there means the worker's `select` and the template's
expectations disagree.

- [ ] **Step 3: Check the visual baselines**

```bash
pnpm test:e2e:local tests/e2e/visual.spec.ts
```

If `reminders-calendar-populated-{desktop,mobile}` diff, that is the collapse
working — the seed has a multi-target reminder. Regenerate **only** through the
dockerized harness:

```bash
pnpm test:visual:update
```

Baselines generated on macOS are pinned to the wrong platform and will diff on
every subsequent run (`CLAUDE.md` § Playwright gotcha). Commit any regenerated
`.png` files separately with a message saying why they moved.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fix/system-covered-target-suppression
gh pr create --fill
```

Then follow the repo's PR convention: watch strictly the **"Sourcery review"**
check first and address its comments; only then `gh pr merge --auto --squash`;
then `gh pr checks --watch --fail-fast`.
