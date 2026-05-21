# Completion-aware ICS calendar feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ICS feed show completed occurrences as `✅`-prefixed events on their completion date, suppress the year-9999 sentinel event for completed one-shots, and render past non-`✅` events as overdue.

**Architecture:** Split assembly from rendering (spec "Approach B"). A new pure function `assembleReminderEvents(input, now)` turns one reminder's `{ recurrence, nextDueOn, completions[] }` into a typed `CalendarEvent[]` (kinds: `completed | due | projected`), applying the `✅` prefix, sentinel suppression, and alarm-skipping rules. `buildIcal` becomes a dumb renderer over `CalendarEvent[]`. The route fetches completions and wires the two together.

**Tech Stack:** TypeScript, Next.js route handler, Prisma 7, `ical-generator`, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-05-21-completion-aware-ics-feed-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/reminders/recurrence.ts` (modify) | Export `FAR_FUTURE` + `isSentinelDate(d)` so the assembler recognizes a done one-shot without a magic literal. |
| `lib/ical/assemble.ts` (create) | Pure function: reminder state + `now` → `CalendarEvent[]`. All the kind/overdue/prefix/alarm rules live here. |
| `lib/ical/assemble.test.ts` (create) | Unit tests for the assembler against a fixed `now`. |
| `lib/ical/build.ts` (modify) | Dumb renderer: `CalendarEvent[]` → ICS string. No business logic. |
| `lib/ical/build.test.ts` (create) | Renderer unit tests (VEVENT count, SUMMARY, all-day, VALARM presence). |
| `app/api/calendar/[token]/route.ts` (modify) | Fetch completions, map reminders through `assembleReminderEvents`, flat-map to `buildIcal`. |
| `tests/integration/ical-feed.test.ts` (modify) | Exercise the route end-to-end with seeded completions; assert `✅` line present and no `9999` event. |

Build order: recurrence export → assembler (+tests) → renderer (+tests) → route → integration. Each task is independently committable.

---

### Task 1: Export the sentinel date from recurrence.ts

**Files:**
- Modify: `lib/reminders/recurrence.ts:5` (the `FAR_FUTURE` const)
- Test: `lib/reminders/recurrence.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/reminders/recurrence.test.ts` (extend the import on line 2 to include the new names):

```typescript
import { computeNextDueOn, FAR_FUTURE, isSentinelDate, previewOccurrences } from './recurrence';

describe('isSentinelDate', () => {
  it('is true for the far-future sentinel a completed one-shot produces', () => {
    const next = computeNextDueOn({ kind: 'once' }, new Date('2026-05-11T00:00:00Z'));
    expect(isSentinelDate(next)).toBe(true);
    expect(isSentinelDate(FAR_FUTURE)).toBe(true);
  });

  it('is false for a normal due date', () => {
    expect(isSentinelDate(new Date('2026-06-30T00:00:00Z'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/reminders/recurrence.test.ts -t isSentinelDate`
Expected: FAIL — `isSentinelDate`/`FAR_FUTURE` are not exported.

- [ ] **Step 3: Implement the minimal change**

In `lib/reminders/recurrence.ts`, change line 5 from `const FAR_FUTURE = ...` to an exported const and add the helper directly below it:

```typescript
export const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

/** True when a date is the "never re-fires" sentinel a completed one-shot carries. */
export function isSentinelDate(d: Date): boolean {
  return d.getTime() === FAR_FUTURE.getTime();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/reminders/recurrence.test.ts`
Expected: PASS (all existing cases + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/reminders/recurrence.ts lib/reminders/recurrence.test.ts
git commit -m "feat(reminders): export FAR_FUTURE sentinel + isSentinelDate helper"
```

---

### Task 2: The pure event assembler

**Files:**
- Create: `lib/ical/assemble.ts`
- Test: `lib/ical/assemble.test.ts`

This is the heart of the feature. Build it test-first, one behavior at a time.

- [ ] **Step 1: Write the failing tests**

Create `lib/ical/assemble.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assembleReminderEvents } from './assemble';

const NOW = new Date('2026-05-21T00:00:00Z');

function base(overrides = {}) {
  return {
    id: 'r1',
    title: 'Replace HVAC filter',
    description: 'use MERV 13',
    leadTimeDays: 3,
    completions: [] as Date[],
    ...overrides,
  };
}

describe('assembleReminderEvents', () => {
  it('recurring: emits a ✅ event per completion + the due event + 11 projections', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
        completions: [new Date('2026-04-04T09:00:00Z'), new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
    );
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'due')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'projected')).toHaveLength(11);
  });

  it('completed events carry the ✅ prefix, no alarm, and the completedOn date', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
        completions: [new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
    );
    const done = events.find((e) => e.kind === 'completed')!;
    expect(done.title).toBe('✅ Replace HVAC filter');
    expect(done.alarmSecondsBefore).toBeNull();
    expect(done.date.toISOString().slice(0, 10)).toBe('2026-05-04');
    expect(done.reminderId).toBe('r1');
  });

  it('completed one-shot: suppresses the sentinel due event, keeps the ✅', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'once' },
        nextDueOn: new Date('9999-12-31T00:00:00.000Z'),
        completions: [new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
    );
    expect(events.filter((e) => e.kind === 'due')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'projected')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(1);
  });

  it('active one-shot: one plain due event, no projections', () => {
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-06-01T00:00:00Z') }),
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('due');
    expect(events[0].title).toBe('Replace HVAC filter');
  });

  it('overdue due date (past): plain title, no alarm', () => {
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-05-10T00:00:00Z') }),
      NOW,
    );
    const due = events.find((e) => e.kind === 'due')!;
    expect(due.title).toBe('Replace HVAC filter');
    expect(due.alarmSecondsBefore).toBeNull();
  });

  it('future due date: carries a lead-time alarm in seconds', () => {
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-06-01T00:00:00Z') }),
      NOW,
    );
    expect(events.find((e) => e.kind === 'due')!.alarmSecondsBefore).toBe(3 * 86_400);
  });

  it('null description becomes empty string on every event', () => {
    const events = assembleReminderEvents(
      base({
        description: null,
        recurrence: { kind: 'once' },
        nextDueOn: new Date('2026-06-01T00:00:00Z'),
      }),
      NOW,
    );
    expect(events.every((e) => e.description === '')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/ical/assemble.test.ts`
Expected: FAIL — module `./assemble` does not exist.

- [ ] **Step 3: Implement `lib/ical/assemble.ts`**

```typescript
import { isSentinelDate, previewOccurrences } from '@/lib/reminders/recurrence';
import type { Recurrence } from '@/lib/reminders/schema';

export type CalendarEventKind = 'completed' | 'due' | 'projected';

export type CalendarEvent = {
  uid: string;
  reminderId: string;
  date: Date; // UTC midnight (all-day)
  title: string; // already prefixed with "✅ " when completed
  description: string; // reminder description ?? '' — same for all kinds
  kind: CalendarEventKind;
  alarmSecondsBefore: number | null; // null = emit no VALARM
};

export type AssembleInput = {
  id: string;
  title: string;
  description: string | null;
  recurrence: Recurrence;
  nextDueOn: Date;
  leadTimeDays: number;
  completions: Date[]; // completedOn values, merged across targets
};

/** Normalize any timestamp to UTC midnight, matching the all-day convention in build.ts. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Turn one reminder's state into the flat list of calendar events the feed should show:
 * a ✅ event per completion (on its completedOn date), the current due event (unless it is
 * the year-9999 sentinel a completed one-shot carries), and future projections.
 * `now` decides whether the due event is overdue (no alarm) or upcoming (lead-time alarm).
 */
export function assembleReminderEvents(input: AssembleInput, now: Date): CalendarEvent[] {
  const description = input.description ?? '';
  const leadSeconds = input.leadTimeDays * 86_400;
  const events: CalendarEvent[] = [];

  for (const completedOn of input.completions) {
    const date = utcMidnight(completedOn);
    events.push({
      uid: `reminder-${input.id}-done-${isoDate(date)}`,
      reminderId: input.id,
      date,
      title: `✅ ${input.title}`,
      description,
      kind: 'completed',
      alarmSecondsBefore: null,
    });
  }

  if (!isSentinelDate(input.nextDueOn)) {
    const date = utcMidnight(input.nextDueOn);
    events.push({
      uid: `reminder-${input.id}-${isoDate(date)}`,
      reminderId: input.id,
      date,
      title: input.title,
      description,
      kind: 'due',
      alarmSecondsBefore: input.nextDueOn.getTime() >= now.getTime() ? leadSeconds : null,
    });

    for (const occ of previewOccurrences(input.recurrence, input.nextDueOn, 11)) {
      const d = utcMidnight(occ);
      events.push({
        uid: `reminder-${input.id}-${isoDate(d)}`,
        reminderId: input.id,
        date: d,
        title: input.title,
        description,
        kind: 'projected',
        alarmSecondsBefore: leadSeconds,
      });
    }
  }

  return events;
}
```

Note: `previewOccurrences` already returns `[]` for `{ kind: 'once' }`, and the sentinel guard means a completed one-shot never reaches the projection loop anyway.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/ical/assemble.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/ical/assemble.ts lib/ical/assemble.test.ts
git commit -m "feat(ical): pure assembleReminderEvents (✅ history, sentinel suppression, overdue)"
```

---

### Task 3: Refactor buildIcal into a renderer over CalendarEvent[]

**Files:**
- Modify: `lib/ical/build.ts` (full rewrite of the function body + types)
- Test: `lib/ical/build.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `lib/ical/build.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildIcal } from './build';
import type { CalendarEvent } from './assemble';

function ev(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    uid: 'reminder-r1-2026-06-30',
    reminderId: 'r1',
    date: new Date('2026-06-30T00:00:00Z'),
    title: 'Replace HVAC filter',
    description: 'use MERV 13',
    kind: 'due',
    alarmSecondsBefore: 3 * 86_400,
    ...overrides,
  };
}

describe('buildIcal', () => {
  it('returns one VEVENT per event with an all-day SUMMARY', () => {
    const text = buildIcal([ev({}), ev({ uid: 'reminder-r1-2026-07-30' })], 'https://example.com');
    expect(text).toContain('BEGIN:VCALENDAR');
    expect((text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(text).toContain('SUMMARY:Replace HVAC filter');
  });

  it('renders the ✅ prefix from a completed event title', () => {
    const text = buildIcal(
      [ev({ title: '✅ Replace HVAC filter', kind: 'completed', alarmSecondsBefore: null })],
      'https://example.com',
    );
    expect(text).toContain('SUMMARY:✅ Replace HVAC filter');
  });

  it('emits a VALARM only when alarmSecondsBefore is set', () => {
    const withAlarm = buildIcal([ev({ alarmSecondsBefore: 3 * 86_400 })], 'https://example.com');
    expect(withAlarm).toContain('TRIGGER:-P3D');

    const noAlarm = buildIcal([ev({ alarmSecondsBefore: null })], 'https://example.com');
    expect(noAlarm).not.toContain('BEGIN:VALARM');
  });

  it('returns no VEVENT for an empty list', () => {
    const text = buildIcal([], 'https://example.com');
    expect(text).not.toContain('BEGIN:VEVENT');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/ical/build.test.ts`
Expected: FAIL — `buildIcal` still expects the old `IcalReminderRow[]` shape (type error / wrong runtime behavior).

- [ ] **Step 3: Rewrite `lib/ical/build.ts`**

Replace the entire file with:

```typescript
import ical, { ICalAlarmType, ICalCalendarMethod } from 'ical-generator';
import type { CalendarEvent } from './assemble';

export function buildIcal(events: CalendarEvent[], appUrl: string): string {
  const cal = ical({
    name: 'House Manager',
    method: ICalCalendarMethod.PUBLISH,
  });
  for (const e of events) {
    const event = cal.createEvent({
      id: e.uid,
      start: e.date,
      end: e.date,
      allDay: true,
      summary: e.title,
      description: e.description,
      url: `${appUrl}/reminders/${e.reminderId}`,
    });
    if (e.alarmSecondsBefore !== null) {
      event.createAlarm({
        type: ICalAlarmType.display,
        trigger: e.alarmSecondsBefore, // seconds before
        description: `${e.title} due`,
      });
    }
  }
  return cal.toString();
}
```

Note: `IcalReminderRow` is removed; `assemble.ts` owns the event type now. The old single-`alarms`-array form is replaced with `createAlarm` so we can conditionally skip it. Verify against the installed `ical-generator` API — if `createAlarm` differs in this version, fall back to passing `alarms: e.alarmSecondsBefore !== null ? [{...}] : []` in `createEvent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/ical/build.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/ical/build.ts lib/ical/build.test.ts
git commit -m "refactor(ical): buildIcal renders a CalendarEvent[] (alarm now conditional)"
```

---

### Task 4: Wire the route to fetch completions and assemble events

**Files:**
- Modify: `app/api/calendar/[token]/route.ts`

- [ ] **Step 1: Update the query and the build call**

Replace the body from the `prisma.reminder.findMany` call through the `buildIcal(...)` call with:

```typescript
const reminders = await prisma.reminder.findMany({
  where: {
    active: true,
    notifyUserIds: { has: user.id },
  },
  select: {
    id: true,
    title: true,
    description: true,
    recurrence: true,
    leadTimeDays: true,
    targets: { select: { nextDueOn: true }, orderBy: { nextDueOn: 'asc' }, take: 1 },
    // Merged across targets — single-series UX. Unbounded today; to cap history later add
    // `where: { completedOn: { gte: cutoff } }` here (see spec, no structural change).
    completions: { select: { completedOn: true }, orderBy: { completedOn: 'asc' } },
  },
});

const env = getEnv();
const events = reminders
  .filter((r) => r.targets.length > 0)
  .flatMap((r) =>
    assembleReminderEvents(
      {
        id: r.id,
        title: r.title,
        description: r.description,
        recurrence: parseRecurrence(r.recurrence),
        nextDueOn: r.targets[0].nextDueOn,
        leadTimeDays: r.leadTimeDays,
        completions: r.completions.map((c) => c.completedOn),
      },
      new Date(),
    ),
  );
const body = buildIcal(events, env.APP_URL ?? '');
```

Add the import at the top: `import { assembleReminderEvents } from '@/lib/ical/assemble';`

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — no type errors (the new `buildIcal` signature matches the assembled `CalendarEvent[]`).

- [ ] **Step 3: Commit**

```bash
git add app/api/calendar/[token]/route.ts
git commit -m "feat(calendar): feed completions through assembleReminderEvents"
```

---

### Task 5: Extend the integration test to cover the route end-to-end

**Files:**
- Modify: `tests/integration/ical-feed.test.ts`

The existing test calls `buildIcal` directly with the old row shape — that no longer compiles. Repoint it at the route handler (the seeded `icsToken: 'tok-abc'` was always intended for this), and add completion + sentinel assertions. **Remove the top-of-file `import { buildIcal } from '@/lib/ical/build';`** — it's now unused and Biome will fail `typecheck`/lint on it.

- [ ] **Step 1: Rewrite the test to exercise the route**

Replace the `describe('buildIcal', ...)` block. Import the route handler and seed reminders + completions via `ctx.prisma`, then call `GET`:

```typescript
import { GET } from '@/app/api/calendar/[token]/route';

async function fetchFeed(token: string): Promise<string> {
  const res = await GET(new Request(`http://test/api/calendar/${token}.ics`), {
    params: Promise.resolve({ token: `${token}.ics` }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe('ICS feed route', () => {
  it('shows a recurring reminder with a ✅ completed event on the completion date', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Replace HVAC filter',
        description: 'use MERV 13',
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        leadTimeDays: 3,
        notifyUserIds: ['u1'],
        targets: { create: { nextDueOn: new Date('2026-06-30T00:00:00Z') } },
      },
      include: { targets: true },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: reminder.id,
        targetId: reminder.targets[0].id,
        completedById: 'u1',
        completedOn: new Date('2026-05-04T10:00:00Z'),
      },
    });

    const text = await fetchFeed('tok-abc');
    expect(text).toContain('SUMMARY:✅ Replace HVAC filter');
    expect(text).toContain('SUMMARY:Replace HVAC filter'); // the due/projected series too
  });

  it('omits the year-9999 sentinel event for a completed one-shot but keeps the ✅', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Register warranty',
        recurrence: { kind: 'once' },
        leadTimeDays: 3,
        notifyUserIds: ['u1'],
        targets: { create: { nextDueOn: new Date('9999-12-31T00:00:00.000Z') } },
      },
      include: { targets: true },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: reminder.id,
        targetId: reminder.targets[0].id,
        completedById: 'u1',
        completedOn: new Date('2026-05-04T10:00:00Z'),
      },
    });

    const text = await fetchFeed('tok-abc');
    expect(text).toContain('SUMMARY:✅ Register warranty');
    expect(text).not.toContain('9999');
  });

  it('keeps both the ✅ and the plain due event when they fall on the same UTC day', async () => {
    const due = new Date('2026-05-10T00:00:00Z');
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'Test collision',
        recurrence: { kind: 'once' },
        leadTimeDays: 3,
        notifyUserIds: ['u1'],
        targets: { create: { nextDueOn: due } },
      },
      include: { targets: true },
    });
    await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: reminder.id,
        targetId: reminder.targets[0].id,
        completedById: 'u1',
        completedOn: new Date('2026-05-10T08:00:00Z'),
      },
    });

    const text = await fetchFeed('tok-abc');
    expect(text).toContain('SUMMARY:✅ Test collision');
    expect(text).toContain('SUMMARY:Test collision');
    expect((text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });
});
```

Adjust field names if the seed shape differs from the schema (e.g. `ReminderCompletion` requires `completedById`, `targetId`, `reminderId`, `completedOn`). Drop the now-unused `buildIcal` import if nothing else uses it.

- [ ] **Step 2: Run the integration test**

Run: `pnpm test:integration`
Expected: PASS (the three new cases; the integration harness spins up the DB via `setupIntegration`).

- [ ] **Step 3: Full local gate**

Run: `pnpm typecheck && pnpm test:unit && pnpm test:integration`
Expected: PASS across the board.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/ical-feed.test.ts
git commit -m "test(ical): route-level coverage for ✅ history + sentinel suppression"
```

---

## Done criteria

- Completed occurrences appear as `✅ <title>` all-day events on their `completedOn` date.
- Completed one-shots no longer emit a `9999-12-31` event.
- A past, non-`✅` due event represents overdue and carries no alarm.
- Existing forward-looking behavior (recurring with no completions) is unchanged.
- `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` all green.
