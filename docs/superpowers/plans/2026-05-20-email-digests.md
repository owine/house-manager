# Email Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add overdue (daily) and weekly-summary (weekly) email digests as the second consumer of the `lib/email/` layer; augment existing per-reminder notifications rather than replace them.

**Architecture:** One `Queue.DigestTick` cron fires every 30 min; the handler matches each user's hour-granular prefs against current local time, dedups via a new `DigestLog` table, queries via pure `lib/digests/queries.ts`, composes via pure `lib/email/templates/digest.tsx` (parameterized by `mode: 'overdue' | 'weekly'`), and sends via the existing `lib/notifications/email.ts` transport. New prefs default off.

**Tech Stack:** TypeScript 6 (strict), Prisma 7 + Postgres, pg-boss 12, React (server-render via `react-dom/server`, no new deps), Vitest 4 + Testcontainers, Biome 2. tz math via `Intl.DateTimeFormat` (same primitive `lib/email/templates/reminder.tsx` already uses).

**Spec:** `docs/superpowers/specs/2026-05-20-email-digests-design.md`

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | modify | add `DigestLog` model with `@@unique([userId, kind, cycle])` |
| `prisma/migrations/{NNN}_digest_logs/migration.sql` | create | the migration produced by `pnpm db:migrate` |
| `lib/notifications/prefs.ts` | modify | extend Zod schema with 5 new digest fields (defaults all off) |
| `lib/notifications/prefs.test.ts` | modify | cover new Zod fields (in-range validation, defaults) |
| `lib/queue.ts` | modify | add `DigestTick: 'digest.tick'` |
| `lib/digests/queries.ts` | create | `getOverdueForUser(userId, tz)` + `getWeeklyForUser(userId, tz)`; pure Prisma; flat `DigestItem[]` projection |
| `lib/digests/queries.test.ts` | create | Testcontainers integration: tz boundaries, active filter, notifyUserIds filter, sort order, empty result |
| `lib/email/templates/digest.tsx` | create | `digestEmail({mode, items, appUrl, timezone}) → {subject, html, text}`; pure; reuses `Layout` + `EMAIL_TOKENS`; mirrors `reminderEmail` patterns (trailing-slash normalization, structured text) |
| `lib/email/templates/digest.test.ts` | create | content + email-client-safety assertions (incl. per-template no-`<style>`/no-class) |
| `worker/jobs/digest-tick.ts` | create | scheduled handler: iterate users, match prefs, dedup, compose, send; APP_URL guard with skip-with-reason |
| `worker/index.ts` | modify | `boss.schedule(Queue.DigestTick, '*/30 * * * *')` + handler registration |
| `tests/integration/digest-tick.test.ts` | create | end-to-end: happy path × 2 modes, dedup, disabled, empty, APP_URL-unset |
| `components/notifications/NotificationPrefsForm.tsx` | modify | render 5 new fields; same form, same save action |
| `lib/notifications/email.ts` | unchanged | transport stays as-is |

---

## Task 1: Schema + prefs Zod + Queue.DigestTick

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_digest_logs/migration.sql` (generated)
- Modify: `lib/notifications/prefs.ts`
- Modify: `lib/notifications/prefs.test.ts`
- Modify: `lib/queue.ts`

This task is foundational — every later task depends on the schema and the new Zod fields. No worker wiring yet; that lands in Task 4.

- [ ] **Step 1: Read the relevant existing files first**

Read in head before editing:
- `lib/notifications/prefs.ts` (Zod schema you'll extend)
- `lib/notifications/prefs.test.ts` (existing test idiom)
- `lib/queue.ts` (the const-object pattern; add one line)
- `prisma/schema.prisma` — find the `User` model (currently has `notificationLogs` and `pushSubscriptions` relations); confirm `NotificationLog` shape for parity reference

- [ ] **Step 2: Add `DigestLog` model to `prisma/schema.prisma`**

Find the `model NotificationLog` block (around line 527) and add this new model directly below it (so related-by-purpose models stay adjacent):

```prisma
model DigestLog {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind        String   // 'overdue' | 'weekly'
  cycle       String   // 'YYYY-MM-DD' for overdue, 'YYYY-Www' (ISO week) for weekly
  sentAt      DateTime @default(now())
  status      String   // 'sent' | 'skipped' | 'failed'
  errorReason String?

  @@unique([userId, kind, cycle])
  @@map("digest_logs")
}
```

Also add the reverse relation to `User`. Find the `model User` block and add `digestLogs DigestLog[]` alongside the existing `notificationLogs NotificationLog[]` relation. (Exact line varies; search for `notificationLogs` inside the User block.)

- [ ] **Step 3: Generate migration**

Run: `pnpm db:migrate` and accept the prompted migration name `digest_logs` (or run with `--name digest_logs` if available).

Expected: a new directory `prisma/migrations/<timestamp>_digest_logs/` containing `migration.sql` with `CREATE TABLE "digest_logs"` and the unique index. Do NOT hand-edit the generated SQL.

- [ ] **Step 4: Extend `notificationPrefsSchema` in `lib/notifications/prefs.ts`**

Append 5 new fields to the existing Zod object, all defaulting off / sensible:

```ts
// Inside notificationPrefsSchema = z.object({ ... existing fields ... ,
overdueDigestEnabled: z.boolean().default(false),
overdueDigestHour:    z.number().int().min(0).max(23).default(8),
weeklySummaryEnabled: z.boolean().default(false),
weeklySummaryDay:     z.number().int().min(0).max(6).default(1), // 0=Sun, 1=Mon, ..., 6=Sat
weeklySummaryHour:    z.number().int().min(0).max(23).default(8),
// })
```

Also add to `defaultNotificationPrefs`:

```ts
overdueDigestEnabled: false,
overdueDigestHour: 8,
weeklySummaryEnabled: false,
weeklySummaryDay: 1,
weeklySummaryHour: 8,
```

- [ ] **Step 5: Add `Queue.DigestTick` in `lib/queue.ts`**

Append one entry to the `Queue` object literal:

```ts
// inside `export const Queue = { ... ,
DigestTick: 'digest.tick',
// } as const;
```

The auto-registration loop at the bottom of `lib/queue.ts` picks this up — no other change in this file needed.

- [ ] **Step 6: Extend `lib/notifications/prefs.test.ts`**

Add test cases asserting:
- `readNotificationPrefs(null)` returns the 5 new defaults (`overdueDigestEnabled: false`, `overdueDigestHour: 8`, `weeklySummaryEnabled: false`, `weeklySummaryDay: 1`, `weeklySummaryHour: 8`).
- In-range validation: `overdueDigestHour: 24` fails parse; `-1` fails; `0` and `23` pass.
- `weeklySummaryDay: 7` fails; `0` and `6` pass.
- A partial input merges with defaults correctly (e.g. `{overdueDigestEnabled: true}` → enabled is true, all other digest defaults applied).

Use the existing test idiom — don't introduce new helpers.

- [ ] **Step 7: Run unit + verify**

Run: `pnpm verify`
Expected: lint + typecheck + unit suite green. The new prefs tests must pass.

- [ ] **Step 8: Run a smoke against the migration**

Run: `pnpm test:integration tests/integration/notify-job.test.ts`
Expected: all 7 cases pass. (Integration uses Testcontainers; runs the migration fresh. If the migration is malformed, this surfaces.)

- [ ] **Step 9: Commit**

Stage explicit paths (don't `-A`):

```bash
git add prisma/schema.prisma prisma/migrations \
        lib/notifications/prefs.ts lib/notifications/prefs.test.ts \
        lib/queue.ts
git commit -m "feat(digests): DigestLog schema + prefs Zod + Queue.DigestTick"
```

---

## Task 2: Pure queries (`lib/digests/queries.ts`) — TDD

**Files:**
- Create: `lib/digests/queries.ts`
- Create: `lib/digests/queries.test.ts`

Pure Prisma queries returning a flat `DigestItem[]` projection. No template, no email, no env. Test against a real Postgres via Testcontainers.

- [ ] **Step 1: Write the failing test file**

```ts
// lib/digests/queries.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './../../tests/integration/helpers';
import type { DigestItem } from './queries';

let ctx: IntegrationContext;
let userId: string;
let categoryId: string;
let itemId: string;
let getOverdueForUser: (userId: string, tz: string) => Promise<DigestItem[]>;
let getWeeklyForUser: (userId: string, tz: string) => Promise<DigestItem[]>;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import to avoid the module-load DATABASE_URL trap.
  const mod = await import('./queries');
  getOverdueForUser = mod.getOverdueForUser;
  getWeeklyForUser = mod.getWeeklyForUser;

  // Seed a user + category once; per-test seeding handles reminders.
  const user = await ctx.prisma.user.create({
    data: { email: 'digest-test@example.test', name: 'Digest Test' },
  });
  userId = user.id;
  const cat = await ctx.prisma.category.create({
    data: { slug: 'digest-test-cat', name: 'DigestTestCat', sortOrder: 999 },
  });
  categoryId = cat.id;
  const item = await ctx.prisma.item.create({
    data: { name: 'TestItem', categoryId },
  });
  itemId = item.id;
});

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  // Reminders cascade-clean their targets; truncate before each case.
  await ctx.prisma.reminder.deleteMany({});
});

describe('getOverdueForUser', () => {
  it('returns items where nextDueOn < startOfToday in the user tz', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Overdue thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: yesterday }] },
      },
    });
    const rows = await getOverdueForUser(userId, 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Overdue thing');
    expect(rows[0]?.daysOverdue).toBeGreaterThan(0);
    expect(rows[0]?.targets).toHaveLength(1);
    expect(rows[0]?.targets[0]).toMatchObject({ kind: 'item', id: itemId, name: 'TestItem' });
  });

  it('excludes inactive reminders', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Inactive overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: false,
        targets: { create: [{ itemId, nextDueOn: yesterday }] },
      },
    });
    expect(await getOverdueForUser(userId, 'America/New_York')).toHaveLength(0);
  });

  it('excludes reminders that do not list the user in notifyUserIds', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Not for me',
        recurrence: { kind: 'NONE' },
        notifyUserIds: ['someone-else'],
        active: true,
        targets: { create: [{ itemId, nextDueOn: yesterday }] },
      },
    });
    expect(await getOverdueForUser(userId, 'America/New_York')).toHaveLength(0);
  });

  it('sorts most-overdue first', async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Recent overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: dayAgo }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'Ancient overdue',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: weekAgo }] },
      },
    });
    const rows = await getOverdueForUser(userId, 'America/New_York');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('Ancient overdue'); // oldest first
    expect(rows[1]?.title).toBe('Recent overdue');
  });

  it('returns empty array when nothing is overdue', async () => {
    expect(await getOverdueForUser(userId, 'America/New_York')).toEqual([]);
  });
});

describe('getWeeklyForUser', () => {
  it('returns items due within now..now+7d', async () => {
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Coming up',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inThreeDays }] },
      },
    });
    const rows = await getWeeklyForUser(userId, 'America/New_York');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Coming up');
    expect(rows[0]?.daysOverdue).toBe(0);
  });

  it('excludes items more than 7 days out', async () => {
    const inTenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Way later',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inTenDays }] },
      },
    });
    expect(await getWeeklyForUser(userId, 'America/New_York')).toHaveLength(0);
  });

  it('sorts due date ascending', async () => {
    const inOneDay = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
    const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Friday thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inFiveDays }] },
      },
    });
    await ctx.prisma.reminder.create({
      data: {
        title: 'Tomorrow thing',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inOneDay }] },
      },
    });
    const rows = await getWeeklyForUser(userId, 'America/New_York');
    expect(rows.map((r) => r.title)).toEqual(['Tomorrow thing', 'Friday thing']);
  });

  it('returns empty array when nothing is due this week', async () => {
    expect(await getWeeklyForUser(userId, 'America/New_York')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/digests/queries.test.ts`
Expected: FAIL — `Cannot find module './queries'`.

- [ ] **Step 3: Implement `lib/digests/queries.ts`**

```ts
import { prisma } from '@/lib/db';

export type DigestItem = {
  reminderId: string;
  title: string;
  dueOn: Date;
  daysOverdue: number; // 0 if not yet overdue
  targets: Array<{ kind: 'item' | 'system'; id: string; name: string }>;
};

/**
 * Compute the start of "today" in the given IANA timezone, returned as a UTC
 * Date suitable for Prisma comparison. Example: timezone='America/New_York'
 * at 2026-05-20T15:00Z returns 2026-05-20T04:00Z (00:00 EDT).
 */
function startOfTodayInTz(timezone: string): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA produces YYYY-MM-DD.
  const today = fmt.format(new Date());
  // Build a UTC anchor for midnight-in-tz: this is the wall-clock midnight in
  // the tz, expressed as the equivalent UTC instant via Date.UTC(...) and a
  // computed offset. Simpler: use the formatted YYYY-MM-DD + 'T00:00:00' in
  // the tz, then re-interpret. We use Intl to get the offset:
  const offsetFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = offsetFmt.formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  // parts looks like "GMT-4" or "GMT+5:30"; parse:
  const m = parts?.match(/^GMT([+-]\d+)(?::(\d+))?$/);
  const offsetMinutes =
    m ? Number(m[1]) * 60 + (m[1]?.startsWith('-') ? -1 : 1) * Number(m[2] ?? 0) : 0;
  // Midnight in tz = (today 00:00) - offset; expressed as a UTC instant.
  const [y, mo, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0) - offsetMinutes * 60_000);
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));
}

async function findAndProject(
  userId: string,
  where: { lt?: Date; gte?: Date; lte?: Date },
  sort: 'asc' | 'desc',
  now: Date,
): Promise<DigestItem[]> {
  const targets = await prisma.reminderTarget.findMany({
    where: {
      nextDueOn: where,
      reminder: { active: true, notifyUserIds: { has: userId } },
    },
    include: {
      reminder: { select: { id: true, title: true } },
      item: { select: { id: true, name: true } },
      system: { select: { id: true, name: true } },
    },
    orderBy: { nextDueOn: sort },
  });
  return targets.map((t) => {
    const target =
      t.item != null
        ? { kind: 'item' as const, id: t.item.id, name: t.item.name }
        : t.system != null
          ? { kind: 'system' as const, id: t.system.id, name: t.system.name }
          : null;
    return {
      reminderId: t.reminder.id,
      title: t.reminder.title,
      dueOn: t.nextDueOn,
      daysOverdue: Math.max(0, daysBetween(now, t.nextDueOn)),
      targets: target ? [target] : [],
    };
  });
}

export async function getOverdueForUser(userId: string, timezone: string): Promise<DigestItem[]> {
  const start = startOfTodayInTz(timezone);
  return findAndProject(userId, { lt: start }, 'asc', new Date());
}

export async function getWeeklyForUser(userId: string, _timezone: string): Promise<DigestItem[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return findAndProject(userId, { gte: now, lte: end }, 'asc', now);
}
```

Notes for the implementer:
- The tz math in `startOfTodayInTz` uses `Intl.DateTimeFormat` only — no new dependency.
- `findAndProject` flattens per-target rows (one DigestItem per target). This matches the spec's "one row per (reminder, target)" decision.
- The week window in `getWeeklyForUser` is rolling-7-days-from-now (not Mon-Sun of the current week) — matches what the spec says: "the window is `[now, now + 7d]`". The `_timezone` parameter is kept for API parity with `getOverdueForUser` even though the rolling-window math doesn't need it; this is intentional (callers shouldn't have to remember which one needs tz).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/digests/queries.test.ts`
Expected: PASS (10/10). If `startOfTodayInTz` mis-handles the offset for a non-`America/New_York` test box, narrow to a single timezone in the tests.

- [ ] **Step 5: Run the broader integration suite**

Run: `pnpm test:integration`
Expected: existing suites green; your 10 new cases green.

- [ ] **Step 6: Commit**

```bash
git add lib/digests/queries.ts lib/digests/queries.test.ts
git commit -m "feat(digests): pure overdue + weekly queries with tz boundary"
```

---

## Task 3: Pure template (`lib/email/templates/digest.tsx`) — TDD

**Files:**
- Create: `lib/email/templates/digest.test.ts`
- Create: `lib/email/templates/digest.tsx`

Pure composition. Reuses `Layout` + `EMAIL_TOKENS` + `renderEmail` from PR #148. No Prisma, no env, no fetch.

- [ ] **Step 1: Write the failing test file**

```ts
// lib/email/templates/digest.test.ts
import { describe, expect, it } from 'vitest';
import { type DigestEmailData, digestEmail } from './digest';

function baseItem(over: Partial<DigestEmailData['items'][number]> = {}) {
  return {
    reminderId: 'rem_1',
    title: 'Replace filter',
    dueOn: new Date('2026-06-01T12:00:00Z'),
    daysOverdue: 0,
    targets: [{ kind: 'item' as const, id: 'itm_1', name: 'Furnace' }],
    ...over,
  };
}

function baseData(over: Partial<DigestEmailData> = {}): DigestEmailData {
  return {
    mode: 'overdue',
    items: [baseItem({ daysOverdue: 3 })],
    appUrl: 'https://hm.example',
    timezone: 'America/New_York',
    ...over,
  };
}

describe('digestEmail', () => {
  it('builds an overdue subject with the count and pluralization', () => {
    expect(digestEmail(baseData({ items: [baseItem({ daysOverdue: 1 })] })).subject)
      .toBe('Overdue: 1 reminder');
    expect(digestEmail(baseData({ items: [baseItem({ daysOverdue: 1 }), baseItem({ reminderId: 'r2', title: 'X', daysOverdue: 2 })] })).subject)
      .toBe('Overdue: 2 reminders');
  });

  it('builds a weekly subject with the count and pluralization', () => {
    const { subject } = digestEmail(
      baseData({ mode: 'weekly', items: [baseItem()] }),
    );
    expect(subject).toBe('This week: 1 reminder due');
  });

  it('renders the correct H1 per mode', () => {
    expect(digestEmail(baseData({ mode: 'overdue' })).html)
      .toContain('Overdue reminders');
    expect(digestEmail(baseData({ mode: 'weekly' })).html)
      .toContain('Reminders due this week');
  });

  it('renders items in the order given (template never re-sorts)', () => {
    const { html } = digestEmail(
      baseData({
        items: [
          baseItem({ reminderId: 'a', title: 'Aaa', daysOverdue: 1 }),
          baseItem({ reminderId: 'b', title: 'Bbb', daysOverdue: 5 }),
        ],
      }),
    );
    expect(html.indexOf('Aaa')).toBeLessThan(html.indexOf('Bbb'));
  });

  it('renders an "Xd overdue" badge in overdue mode', () => {
    const { html } = digestEmail(
      baseData({ mode: 'overdue', items: [baseItem({ daysOverdue: 7 })] }),
    );
    expect(html).toMatch(/7d overdue/);
  });

  it('renders a "due {date}" badge in weekly mode formatted in the supplied tz', () => {
    const { html } = digestEmail(
      baseData({
        mode: 'weekly',
        timezone: 'America/New_York',
        items: [baseItem({ dueOn: new Date('2026-06-01T12:00:00Z') })],
      }),
    );
    // 2026-06-01T12:00:00Z is June 1 in America/New_York (08:00 EDT).
    expect(html).toMatch(/due (June 1, 2026|Jun 1, 2026)/);
  });

  it('links each reminder title to {appUrl}/reminders/{id}', () => {
    const { html } = digestEmail(baseData());
    expect(html).toContain('href="https://hm.example/reminders/rem_1"');
  });

  it('links item targets to /items/{id} and system targets to /systems/{id}', () => {
    const itemHtml = digestEmail(
      baseData({ items: [baseItem({ targets: [{ kind: 'item', id: 'itm_1', name: 'Furnace' }] })] }),
    ).html;
    expect(itemHtml).toContain('href="https://hm.example/items/itm_1"');

    const sysHtml = digestEmail(
      baseData({ items: [baseItem({ targets: [{ kind: 'system', id: 'sys_1', name: 'HVAC' }] })] }),
    ).html;
    expect(sysHtml).toContain('href="https://hm.example/systems/sys_1"');
  });

  it('includes the settings footer link', () => {
    const { html } = digestEmail(baseData());
    expect(html).toContain('href="https://hm.example/settings"');
    expect(html).toContain('Manage notification settings');
  });

  it('returns a non-empty structured text (not html-stripped)', () => {
    const { text } = digestEmail(baseData());
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toContain('Replace filter');
    expect(text).toContain('https://hm.example/reminders/rem_1');
  });

  it('escapes html in titles to prevent injection', () => {
    const { html } = digestEmail(
      baseData({ items: [baseItem({ title: '<script>alert(1)</script>Foo' })] }),
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  it('produces no <style> tags (per-template safety contract)', () => {
    const { html } = digestEmail(baseData());
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('produces no class/className attributes (per-template safety contract)', () => {
    const { html } = digestEmail(baseData());
    expect(html).not.toMatch(/\bclass\s*=/i);
    expect(html).not.toMatch(/\bclassName\s*=/i);
  });

  it('normalizes trailing slash(es) in appUrl', () => {
    const { html, text } = digestEmail(baseData({ appUrl: 'https://hm.example//' }));
    expect(html).toContain('href="https://hm.example/reminders/rem_1"');
    expect(html).not.toContain('hm.example//');
    expect(text).not.toContain('hm.example//');
  });

  it('throws when called with an empty items array (handler should skip first)', () => {
    expect(() => digestEmail(baseData({ items: [] }))).toThrow(/non-empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/email/templates/digest.test.ts`
Expected: FAIL — `Cannot find module './digest'`.

- [ ] **Step 3: Implement `lib/email/templates/digest.tsx`**

```tsx
import type { ReactNode } from 'react';
import { EMAIL_TOKENS, Layout } from '../layout';
import { renderEmail } from '../render';

const T = EMAIL_TOKENS;

export type DigestItemTarget =
  | { kind: 'item'; id: string; name: string }
  | { kind: 'system'; id: string; name: string };

export type DigestItem = {
  reminderId: string;
  title: string;
  dueOn: Date;
  daysOverdue: number;
  targets: DigestItemTarget[];
};

export type DigestEmailData = {
  mode: 'overdue' | 'weekly';
  items: DigestItem[]; // template never re-sorts; query owns order
  appUrl: string;
  timezone: string;
};

export type DigestEmailResult = { subject: string; html: string; text: string };

function formatDue(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

function pluralize(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

function targetHref(t: DigestItemTarget, appUrl: string): string {
  return t.kind === 'item' ? `${appUrl}/items/${t.id}` : `${appUrl}/systems/${t.id}`;
}

function Body({ data }: { data: DigestEmailData }): ReactNode {
  const h1 = data.mode === 'overdue' ? 'Overdue reminders' : 'Reminders due this week';
  return (
    <>
      <h1
        style={{
          margin: '0 0 16px 0',
          fontSize: '20px',
          lineHeight: 1.25,
          color: T.ink,
          fontWeight: 600,
        }}
      >
        {h1}
      </h1>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {data.items.map((it) => (
          <li
            key={it.reminderId}
            style={{
              borderTop: `1px solid ${T.line}`,
              padding: '12px 0',
            }}
          >
            <a
              href={`${data.appUrl}/reminders/${it.reminderId}`}
              style={{ color: T.accent, fontWeight: 500, textDecoration: 'none' }}
            >
              {it.title}
            </a>
            <div style={{ color: T.inkMuted, fontSize: '14px', marginTop: '4px' }}>
              {it.targets.map((t, i) => (
                <span key={`${t.kind}-${t.id}`}>
                  {i > 0 ? ', ' : ''}
                  <a href={targetHref(t, data.appUrl)} style={{ color: T.inkMuted }}>
                    {t.name}
                  </a>
                </span>
              ))}
              {it.targets.length > 0 ? ' · ' : ''}
              {data.mode === 'overdue'
                ? `${it.daysOverdue}d overdue`
                : `due ${formatDue(it.dueOn, data.timezone)}`}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function buildText(data: DigestEmailData): string {
  const lines: string[] = [];
  lines.push(data.mode === 'overdue' ? 'Overdue reminders' : 'Reminders due this week');
  lines.push('');
  for (const it of data.items) {
    const badge =
      data.mode === 'overdue'
        ? `${it.daysOverdue}d overdue`
        : `due ${formatDue(it.dueOn, data.timezone)}`;
    const targetNames = it.targets.map((t) => t.name).join(', ');
    lines.push(`- ${it.title}${targetNames ? ` (${targetNames})` : ''} — ${badge}`);
    lines.push(`  ${data.appUrl}/reminders/${it.reminderId}`);
    for (const t of it.targets) {
      lines.push(`  ${targetHref(t, data.appUrl)}`);
    }
    lines.push('');
  }
  lines.push(`Manage notification settings: ${data.appUrl}/settings`);
  return lines.join('\n');
}

export function digestEmail(data: DigestEmailData): DigestEmailResult {
  if (data.items.length === 0) {
    throw new Error('digestEmail requires non-empty items; handler should have skipped');
  }
  // Normalize trailing slashes once at the entry point — same pattern as reminder.tsx.
  const normalized: DigestEmailData = {
    ...data,
    appUrl: data.appUrl.replace(/\/+$/, ''),
  };
  const count = normalized.items.length;
  const subject =
    normalized.mode === 'overdue'
      ? `Overdue: ${count} ${pluralize(count, 'reminder')}`
      : `This week: ${count} ${pluralize(count, 'reminder')} due`;
  const { html } = renderEmail(
    <Layout preheader={subject} appUrl={normalized.appUrl}>
      <Body data={normalized} />
    </Layout>,
  );
  const text = buildText(normalized);
  return { subject, html, text };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/email/templates/digest.test.ts`
Expected: PASS (15/15). If a date-formatting test fails on locale, narrow the regex.

- [ ] **Step 5: Run `pnpm verify`**

Run: `pnpm verify`
Expected: lint + typecheck + full unit suite green.

- [ ] **Step 6: Commit**

```bash
git add lib/email/templates/digest.tsx lib/email/templates/digest.test.ts
git commit -m "feat(digests): pure digestEmail template + content + safety tests"
```

---

## Task 4: Worker handler + registration

**Files:**
- Create: `worker/jobs/digest-tick.ts`
- Modify: `worker/index.ts`
- Create: `tests/integration/digest-tick.test.ts`

Orchestration: every 30 min, iterate users, match prefs, dedup via `DigestLog`, call queries → template → transport. APP_URL guard with skip-with-reason mirrors `notify.ts:113-122`.

- [ ] **Step 1: Read prerequisite files first**

In head before editing:
- `worker/jobs/notify.ts` — for the skip-with-reason + log-create-then-catch dedup pattern you'll mirror
- `worker/jobs/reminders-tick.ts` — for the cron-tick-handler shape
- `worker/index.ts` — see where existing `boss.schedule` / `boss.work` calls live (lines 53, 100, 106, 112)
- `tests/integration/notify-job.test.ts` — the `vi.mock` setup you'll copy

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/digest-tick.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';
import { getEnv } from '@/lib/env';

const sentEmails: unknown[] = [];

vi.mock('@/lib/notifications/email', () => ({
  sendEmail: vi.fn(async (_to: string, payload: unknown) => {
    sentEmails.push(payload);
    return { ok: true };
  }),
}));

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ APP_URL: 'http://localhost:3000' })),
}));

let ctx: IntegrationContext;
let userId: string;
let categoryId: string;
let itemId: string;
let handleDigestTick: () => Promise<void>;

beforeAll(async () => {
  ctx = await setupIntegration();
  const mod = await import('@/worker/jobs/digest-tick');
  handleDigestTick = mod.handleDigestTick;
  const cat = await ctx.prisma.category.create({
    data: { slug: 'digest-tick-cat', name: 'DTCat', sortOrder: 999 },
  });
  categoryId = cat.id;
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  sentEmails.length = 0;
  await ctx.prisma.digestLog.deleteMany({});
  await ctx.prisma.reminder.deleteMany({});
  await ctx.prisma.user.deleteMany({});
  // Fresh user per test so we can control prefs and the cycle key.
  const nowHour = new Date().getUTCHours(); // tests run in UTC tz pref to match
  const user = await ctx.prisma.user.create({
    data: {
      email: 'tick@example.test',
      name: 'Tick',
      notificationPrefs: {
        emailEnabled: true,
        timezone: 'UTC',
        overdueDigestEnabled: true,
        overdueDigestHour: nowHour,
        weeklySummaryEnabled: false,
        weeklySummaryDay: 1,
        weeklySummaryHour: 8,
      },
    },
  });
  userId = user.id;
});

async function seedOverdue() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await ctx.prisma.reminder.create({
    data: {
      title: 'Filter',
      recurrence: { kind: 'NONE' },
      notifyUserIds: [userId],
      active: true,
      targets: { create: [{ itemId, nextDueOn: yesterday }] },
    },
  });
}

describe('handleDigestTick — overdue path', () => {
  it('sends one email + writes a sent DigestLog row when an overdue item exists', async () => {
    await seedOverdue();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(1);
    const payload = sentEmails[0] as { subject: string; html: string; text: string };
    expect(payload.subject).toMatch(/^Overdue: /);
    expect(payload.html).toContain('Filter');
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'overdue' } });
    expect(log?.status).toBe('sent');
  });

  it('is idempotent: a second tick in the same cycle does not re-send', async () => {
    await seedOverdue();
    await handleDigestTick();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(1);
    const logs = await ctx.prisma.digestLog.findMany({ where: { userId, kind: 'overdue' } });
    expect(logs).toHaveLength(1);
  });

  it('does not send when overdueDigestEnabled is false', async () => {
    await ctx.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: { emailEnabled: true, timezone: 'UTC', overdueDigestEnabled: false } },
    });
    await seedOverdue();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(0);
    expect(await ctx.prisma.digestLog.count()).toBe(0);
  });

  it('skips with "nothing to report" when no overdue items exist', async () => {
    await handleDigestTick();
    expect(sentEmails).toHaveLength(0);
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'overdue' } });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('nothing to report');
  });

  it('skips with "APP_URL not configured" when env.APP_URL is unset', async () => {
    vi.mocked(getEnv).mockReturnValueOnce({ APP_URL: undefined } as unknown as ReturnType<typeof getEnv>);
    await seedOverdue();
    await handleDigestTick();
    expect(sentEmails).toHaveLength(0);
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'overdue' } });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('APP_URL not configured');
  });
});

describe('handleDigestTick — weekly path', () => {
  it('sends the weekly digest when day + hour match and the query is non-empty', async () => {
    const now = new Date();
    const dayIdx = now.getUTCDay();
    const hour = now.getUTCHours();
    await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        notificationPrefs: {
          emailEnabled: true,
          timezone: 'UTC',
          overdueDigestEnabled: false,
          weeklySummaryEnabled: true,
          weeklySummaryDay: dayIdx,
          weeklySummaryHour: hour,
        },
      },
    });
    const inThreeDays = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await ctx.prisma.reminder.create({
      data: {
        title: 'Upcoming',
        recurrence: { kind: 'NONE' },
        notifyUserIds: [userId],
        active: true,
        targets: { create: [{ itemId, nextDueOn: inThreeDays }] },
      },
    });
    await handleDigestTick();
    expect(sentEmails).toHaveLength(1);
    const payload = sentEmails[0] as { subject: string };
    expect(payload.subject).toMatch(/^This week: /);
    const log = await ctx.prisma.digestLog.findFirst({ where: { userId, kind: 'weekly' } });
    expect(log?.status).toBe('sent');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/integration/digest-tick.test.ts`
Expected: FAIL — `Cannot find module '@/worker/jobs/digest-tick'`. (Or fails on `prisma.digestLog` if the Prisma client wasn't regenerated after Task 1's migration; run `pnpm db:generate` if so.)

- [ ] **Step 4: Implement `worker/jobs/digest-tick.ts`**

```ts
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { digestEmail } from '@/lib/email/templates/digest';
import { getOverdueForUser, getWeeklyForUser } from '@/lib/digests/queries';
import { sendEmail } from '@/lib/notifications/email';
import { readNotificationPrefs } from '@/lib/notifications/prefs';

type DigestKind = 'overdue' | 'weekly';

/**
 * Compute YYYY-MM-DD and ISO week (YYYY-Www) for "now" in the given tz.
 * Uses Intl.DateTimeFormat only — no new dependency.
 */
function localParts(timezone: string): {
  hour: number;
  day: number; // 0=Sunday..6=Saturday
  date: string; // YYYY-MM-DD
  week: string; // YYYY-Www (ISO week)
} {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const day = dayMap[parts.weekday] ?? 0;
  // ISO week: a Thursday-based week-of-year, year is the Thursday's year.
  const [y, m, d] = [Number(parts.year), Number(parts.month), Number(parts.day)] as [number, number, number];
  const dUtc = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dUtc.getUTCDay() || 7; // 1..7, Mon..Sun
  dUtc.setUTCDate(dUtc.getUTCDate() + 4 - dayOfWeek); // shift to Thursday
  const yearStart = Date.UTC(dUtc.getUTCFullYear(), 0, 1);
  const weekNum = Math.ceil((((dUtc.getTime() - yearStart) / 86400000) + 1) / 7);
  const week = `${dUtc.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  return { hour, day, date, week };
}

async function maybeSend(
  userId: string,
  userEmail: string,
  kind: DigestKind,
  cycle: string,
  appUrl: string,
  timezone: string,
): Promise<void> {
  // Write-log-first-then-catch: the unique constraint is the dedup primitive.
  let logId: string;
  try {
    const log = await prisma.digestLog.create({
      data: { userId, kind, cycle, status: 'sent' /* tentative; updated below */ },
      select: { id: true },
    });
    logId = log.id;
  } catch {
    // Already sent (or skipped) for this cycle — nothing to do.
    return;
  }
  const items =
    kind === 'overdue'
      ? await getOverdueForUser(userId, timezone)
      : await getWeeklyForUser(userId, timezone);
  if (items.length === 0) {
    await prisma.digestLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'nothing to report' },
    });
    return;
  }
  const { subject, html, text } = digestEmail({ mode: kind, items, appUrl, timezone });
  const r = await sendEmail(userEmail, { subject, text, html });
  await prisma.digestLog.update({
    where: { id: logId },
    data: r.ok ? { status: 'sent' } : { status: 'failed', errorReason: r.reason },
  });
}

export async function handleDigestTick(): Promise<void> {
  const env = getEnv();
  const users = await prisma.user.findMany({
    where: { email: { not: null } },
    select: { id: true, email: true, notificationPrefs: true },
  });
  for (const u of users) {
    if (!u.email) continue;
    const prefs = readNotificationPrefs(u.notificationPrefs);
    if (!prefs.emailEnabled) continue;
    if (!prefs.overdueDigestEnabled && !prefs.weeklySummaryEnabled) continue;

    if (!env.APP_URL) {
      // Log one skipped row per applicable kind so the user can see why.
      const local = localParts(prefs.timezone);
      const skippedKinds: Array<[DigestKind, string]> = [];
      if (prefs.overdueDigestEnabled && local.hour === prefs.overdueDigestHour) {
        skippedKinds.push(['overdue', local.date]);
      }
      if (
        prefs.weeklySummaryEnabled &&
        local.day === prefs.weeklySummaryDay &&
        local.hour === prefs.weeklySummaryHour
      ) {
        skippedKinds.push(['weekly', local.week]);
      }
      for (const [kind, cycle] of skippedKinds) {
        try {
          await prisma.digestLog.create({
            data: {
              userId: u.id,
              kind,
              cycle,
              status: 'skipped',
              errorReason: 'APP_URL not configured',
            },
          });
        } catch {
          // already logged
        }
      }
      if (skippedKinds.length > 0) {
        console.warn(`digest-tick: APP_URL not configured; skipped ${skippedKinds.length} for user ${u.id}`);
      }
      continue;
    }

    const local = localParts(prefs.timezone);

    if (prefs.overdueDigestEnabled && local.hour === prefs.overdueDigestHour) {
      await maybeSend(u.id, u.email, 'overdue', local.date, env.APP_URL, prefs.timezone);
    }
    if (
      prefs.weeklySummaryEnabled &&
      local.day === prefs.weeklySummaryDay &&
      local.hour === prefs.weeklySummaryHour
    ) {
      await maybeSend(u.id, u.email, 'weekly', local.week, env.APP_URL, prefs.timezone);
    }
  }
}
```

Notes for implementer:
- The write-log-first dedup matches `notify.ts:55-65` exactly.
- The `localParts` helper does ISO-week math inline; no new dep.
- If your test box clock vs the user's tz produces a different hour at the moment the test runs, the test's `nowHour = new Date().getUTCHours()` + `timezone: 'UTC'` keeps both sides in sync.
- We deliberately log an `APP_URL not configured` row per applicable kind even when no items would have been queried — this preserves the spec's "self-hoster can see exactly why no email arrived" invariant.

- [ ] **Step 5: Register the handler in `worker/index.ts`**

Add at the import block:
```ts
import { handleDigestTick } from './jobs/digest-tick';
```

Add a new schedule + work pair (alongside the existing `NotifyLogSweep` / `PgDump` blocks — these are all "scheduled background sweeps"):

```ts
await boss.schedule(Queue.DigestTick, '*/30 * * * *');
await boss.work(Queue.DigestTick, { batchSize: 1 }, async () => {
  await handleDigestTick();
});
```

- [ ] **Step 6: Run the integration test**

Run: `pnpm vitest run tests/integration/digest-tick.test.ts`
Expected: PASS (6/6). If `prisma.digestLog` is undefined, run `pnpm db:generate` first.

- [ ] **Step 7: Run the broader integration suite**

Run: `pnpm test:integration`
Expected: existing 298 + 10 (Task 2) + 6 (this task) = 314 cases green.

- [ ] **Step 8: Commit**

```bash
git add worker/jobs/digest-tick.ts worker/index.ts tests/integration/digest-tick.test.ts
git commit -m "feat(digests): tick handler + worker registration + integration tests"
```

---

## Task 5: Settings UI — extend `NotificationPrefsForm`

**Files:**
- Modify: `components/notifications/NotificationPrefsForm.tsx`

The existing form is a React Hook Form + Zod component already wired to `saveNotificationPrefs`. Adding 5 fields to the schema + 5 form controls is the whole change.

- [ ] **Step 1: Read the existing form**

Read `/Users/owine/Git/house-manager/components/notifications/NotificationPrefsForm.tsx` start to finish. Note:
- It already imports `Checkbox` from `@/components/ui/checkbox` (use that — match existing style, NOT `Switch`).
- It already imports `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` from `@/components/ui/select`.
- It uses `FormField` / `FormItem` / `FormLabel` / `FormControl` / `FormMessage` from `@/components/ui/form`.
- Match the existing layout idioms (spacing, label wording, grouping).

- [ ] **Step 2: Add a new "Digest emails" section to the form**

Append (within the form's `<div className="space-y-...">` container, after the existing notification-prefs fields and before the submit row) a new section with:

```tsx
{/* --- Digest emails --- */}
<div className="space-y-4">
  <h3 className="text-sm font-medium">Digest emails</h3>

  <FormField
    control={form.control}
    name="overdueDigestEnabled"
    render={({ field }) => (
      <FormItem className="flex items-center gap-2 space-y-0">
        <FormControl>
          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
        </FormControl>
        <FormLabel className="font-normal">
          Send an overdue digest daily
        </FormLabel>
      </FormItem>
    )}
  />

  <FormField
    control={form.control}
    name="overdueDigestHour"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Overdue digest time</FormLabel>
        <Select
          disabled={!form.watch('overdueDigestEnabled')}
          value={String(field.value)}
          onValueChange={(v) => field.onChange(Number(v))}
        >
          <FormControl>
            <SelectTrigger><SelectValue /></SelectTrigger>
          </FormControl>
          <SelectContent>
            {Array.from({ length: 24 }, (_, h) => (
              <SelectItem key={h} value={String(h)}>
                {String(h).padStart(2, '0')}:00
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FormMessage />
      </FormItem>
    )}
  />

  <FormField
    control={form.control}
    name="weeklySummaryEnabled"
    render={({ field }) => (
      <FormItem className="flex items-center gap-2 space-y-0">
        <FormControl>
          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
        </FormControl>
        <FormLabel className="font-normal">
          Send a weekly summary
        </FormLabel>
      </FormItem>
    )}
  />

  <div className="grid grid-cols-2 gap-4">
    <FormField
      control={form.control}
      name="weeklySummaryDay"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Day</FormLabel>
          <Select
            disabled={!form.watch('weeklySummaryEnabled')}
            value={String(field.value)}
            onValueChange={(v) => field.onChange(Number(v))}
          >
            <FormControl>
              <SelectTrigger><SelectValue /></SelectTrigger>
            </FormControl>
            <SelectContent>
              {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(
                (label, idx) => (
                  <SelectItem key={idx} value={String(idx)}>{label}</SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
    <FormField
      control={form.control}
      name="weeklySummaryHour"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Time</FormLabel>
          <Select
            disabled={!form.watch('weeklySummaryEnabled')}
            value={String(field.value)}
            onValueChange={(v) => field.onChange(Number(v))}
          >
            <FormControl>
              <SelectTrigger><SelectValue /></SelectTrigger>
            </FormControl>
            <SelectContent>
              {Array.from({ length: 24 }, (_, h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, '0')}:00
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  </div>
</div>
```

Place this block **inside** the form, before the submit button row. Confirm the field names (`overdueDigestEnabled`, etc.) match the Zod schema added in Task 1 exactly — TypeScript via `notificationPrefsSchema` typing will catch typos at compile time.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If the form's RHF generic type doesn't include the new fields, ensure the form is typed against `z.input<typeof notificationPrefsSchema>` (it already is per Step 1's read) — the new fields are inferred automatically.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Smoke the page locally (optional)**

If you want a quick visual check: `pnpm dev`, navigate to `/settings`, expand the notifications section, confirm the new fields render, toggle a checkbox, change a time, and submit. Confirm a toast appears and the values persist on reload. Skip if you trust the typecheck + existing form's save path.

- [ ] **Step 6: Commit**

```bash
git add components/notifications/NotificationPrefsForm.tsx
git commit -m "feat(digests): settings UI for digest schedule prefs"
```

---

## Task 6: Final verify + finishing

- [ ] **Step 1: Full verify**

Run: `pnpm verify`
Expected: lint + typecheck + unit suite green.

- [ ] **Step 2: Integration suite**

Run: `pnpm test:integration`
Expected: all 314+ cases green.

- [ ] **Step 3: E2E**

Run: `pnpm test:e2e`
Expected: green. If your local env doesn't have the docker stack up, defer to CI per the project's convention (same as Plan 4a / Outbound Email Templates).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: PASS (or, if env vars aren't set locally, identical to the pre-existing "Failed to collect page data" build behavior on `main` — that's environmental, not introduced by this work).

- [ ] **Step 5: Optional manual smoke**

In a local stack with the worker running and `APP_URL` set:
- Enable the overdue digest in `/settings` for the current hour.
- Seed an overdue reminder.
- Wait for the next 30-min tick (or force one via `pgboss.send(Queue.DigestTick, {})`).
- Confirm an email arrives and a `DigestLog` row exists with `status='sent'`.
- Force the APP_URL-unset path: unset `APP_URL`, re-trigger, confirm a `DigestLog` row appears with `status='skipped'` and `errorReason='APP_URL not configured'`.

- [ ] **Step 6: Hand off to `superpowers:finishing-a-development-branch`**

Invoke that skill to push the branch and open the PR. Include in the PR description:
- Spec + plan links
- The defaults-off behavior (no surprise emails for existing users)
- The new `DigestLog` table (one new model, one new migration)
- The deferred CI checks (build / e2e if local couldn't run them)

---

## Cadence reminders

- One combined-reviewer Haiku review per task before marking complete (per [[feedback-execution-cadence]]).
- Don't push during execution; branch accumulates and the push happens via `finishing-a-development-branch`.
- All commits signed (1Password auto). Stage explicit paths. Never `--no-verify`.
- The DB-trap pattern: any test that transitively imports `lib/db.ts` at module scope uses dynamic-import-in-`beforeAll` (Task 2's and Task 4's test files both do this).
- If a Sourcery comment lands on the PR after push, apply the [[project-outbound-email-templates-status]] discipline: verify claims against the actual file, accept legitimate suggestions, push back with evidence on incorrect ones, ignore hallucinated field names.
