# Email Digests — Design

**Date:** 2026-05-20
**Status:** Design — pending review

## Problem

Today, every reminder fires its own push and (if enabled) its own email notification at `nextDueOn - leadTimeDays`. That works per-reminder but offers no aggregate view:

- An item with several overdue reminders produces several disconnected emails.
- There's no "what's coming up this week" summary surface; the user has to open the app to see.
- The new `lib/email/` composition layer (shipped 2026-05-20 as `0832efa`, see [[project-outbound-email-templates-status]]) has exactly one consumer; the reusable boundaries it claims are unproven without a second template type.

This work adds two scheduled email types — **overdue digest** (daily) and **weekly summary** — that augment (do not replace) the per-reminder notifications.

## Goals

- Two new outbound email types sharing one cron handler, one template (parameterized by mode), and one new dedup table.
- Validate the `lib/email/` layer's reusability claim by adding the second consumer.
- Per-user schedule prefs (default off; opt in via the settings UI).
- Skip-when-empty so digests stay quiet on quiet days.
- Same `APP_URL`-unset skip-with-reason discipline as `notify.ts`.
- Idempotent cron so a 30-minute tick can't double-send.

## Non-goals

- No change to existing per-reminder push/email behavior (augment, not replace).
- No per-`ReminderKind` template variants (a separate Spec B will cover that).
- No grouping by day or by kind inside the digest (flat sorted list only — YAGNI).
- No new transport; reuses `lib/notifications/email.ts` untouched.
- No new runtime dependencies.
- No notification settings beyond the digest schedule (no separate "digest push" channel etc.).

## Architecture

Three units, each with one clear responsibility — mirrors the discipline in [[project-outbound-email-templates-status]]:

| Unit | Responsibility | Depends on |
|---|---|---|
| `lib/digests/queries.ts` (new) | **Data** — pure Prisma queries returning a flat `DigestItem[]` projection | Prisma |
| `lib/email/templates/digest.tsx` (new) | **Composition** — pure: `digestEmail({mode, items, appUrl, timezone}) → {subject, html, text}` | React + `lib/email/{layout,render}` (no Prisma, no env, no fetch) |
| `worker/jobs/digest-tick.ts` (new) | **Orchestration** — every 30 min: iterate users, match prefs, dedup via `DigestLog`, query → template → transport | Prisma + the two units above + `lib/notifications/email.ts` |

The transport (`lib/notifications/email.ts`) stays unchanged. The settings UI (`app/(app)/settings/page.tsx`) gains a new section. `lib/notifications/prefs.ts` extends its Zod schema. `lib/queue.ts` gains a new `Queue.DigestTick`. `worker/index.ts` schedules + registers the handler.

### One template, two modes

`digestEmail({mode: 'overdue' | 'weekly', items, appUrl, timezone})` — single parameterized template, not two near-duplicates. Per the "flat sorted list" content decision, the two modes share layout entirely; only subject wording, H1, and per-item badge text differ. If the two ever diverge meaningfully later, split then.

### File structure

| File | Status | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | modify | add `DigestLog` model + `@@unique([userId, kind, cycle])`; new migration |
| `lib/notifications/prefs.ts` | modify | extend Zod with 5 new digest-pref fields, all default off |
| `lib/queue.ts` | modify | add `Queue.DigestTick` |
| `lib/digests/queries.ts` | create | `getOverdueForUser(userId, tz)` + `getWeeklyForUser(userId, tz)`; pure Prisma |
| `lib/digests/queries.test.ts` | create | integration tests (Testcontainers) over the queries |
| `lib/email/templates/digest.tsx` | create | `digestEmail(...)`; pure, parameterized by mode |
| `lib/email/templates/digest.test.ts` | create | content + email-client-safety assertions |
| `worker/jobs/digest-tick.ts` | create | scheduled handler; matches prefs, dedups, composes, sends |
| `worker/index.ts` | modify | `boss.schedule(Queue.DigestTick, '*/30 * * * *')` + handler registration |
| `tests/integration/digest-tick.test.ts` | create | end-to-end of the tick handler against real Postgres |
| `app/(app)/settings/page.tsx` | modify | new "Digest emails" section: two toggles + hour/day pickers |
| `lib/notifications/email.ts` | unchanged | transport stays as-is |

## Cron, prefs, dedup

### Cron

`boss.schedule(Queue.DigestTick, '*/30 * * * *')` registered in `worker/index.ts` alongside the existing `RemindersTick` and `NotifyLogSweep` schedules. The 30-minute cadence is **outage-recovery insurance, not a duplication risk**: because prefs are hour-granular, each user's `(kind, cycle)` combination has at most one eligible send window per cycle. The `@@unique` constraint on `DigestLog` guarantees that even if two ticks fall inside that window, the second is a no-op. If one tick misses entirely (worker restart, brief DB outage), the next attempts again within the same hour.

### Handler shape (`digest-tick.ts`)

Stateless and idempotent. Every invocation:

1. Reads `env.APP_URL` once. If unset, for each user, for each digest kind whose hour-match-window applies *right now* (i.e. would have been sent this tick), write a `DigestLog { status: 'skipped', errorReason: 'APP_URL not configured' }` and `console.warn`. Don't log skipped rows for users/kinds that wouldn't have fired this hour anyway — that would create spurious rows the user has to mentally filter. Same skip-with-reason discipline as `notify.ts`.
2. Loads all users where `notificationPrefs.emailEnabled === true` AND (`overdueDigestEnabled` OR `weeklySummaryEnabled`) AND `email` is set.
3. For each user, computes `now` in `notificationPrefs.timezone` (hour, day-of-week, ISO week, today's date string).
4. **Overdue path:** if `overdueDigestEnabled && localHour === overdueDigestHour` and no `DigestLog` row exists for `(userId, 'overdue', cycle: 'YYYY-MM-DD')`:
   - Query `getOverdueForUser(userId, tz)`.
   - If empty: write `DigestLog { status: 'skipped', errorReason: 'nothing to report' }`. Don't send.
   - If non-empty: `digestEmail({mode: 'overdue', items, appUrl, timezone})` → `sendEmail` → write `DigestLog { status: 'sent' | 'failed', errorReason? }`.
5. **Weekly path:** if `weeklySummaryEnabled && localDayOfWeek === weeklySummaryDay && localHour === weeklySummaryHour` and no `DigestLog` for `(userId, 'weekly', cycle: 'YYYY-Www')` (ISO week): same shape, `getWeeklyForUser(...)`, `mode: 'weekly'`.

The dedup property (don't re-send within the same cycle) comes from the `@@unique` — a second tick in the same hour either finds the prior row and skips, or races into a unique-constraint violation that the handler catches (matching the existing `notificationLog.create`-then-catch pattern in `notify.ts`). The row is `create`d with `status: 'queued'` first (the dedup write must precede the send), then updated to `'sent' | 'failed' | 'skipped'` once the send resolves. Mirrors `notify.ts:58`; a process crash between create and update leaves the row in `'queued'`, which is honest about its state.

### Pref schema (extends `notificationPrefsSchema` Zod)

```ts
overdueDigestEnabled: z.boolean().default(false),
overdueDigestHour:    z.number().int().min(0).max(23).default(8),
weeklySummaryEnabled: z.boolean().default(false),
weeklySummaryDay:     z.number().int().min(0).max(6).default(1),  // 0=Sunday, 1=Monday
weeklySummaryHour:    z.number().int().min(0).max(23).default(8),
```

**Both default off** so adding the feature doesn't surprise the user with new mail. Granularity is **hourly**, not minute. `'HH:MM'` was rejected as bikeshedding — a digest email is not time-critical enough that 08:00-vs-08:15 matters, and an integer hour is simpler to UI, store, and match against the tick.

### Dedup table

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

A new table rather than reusing `NotificationLog`. Rationale: `NotificationLog.reminderId` is `NOT NULL` with an FK to `Reminder`; digests aren't per-reminder, so reusing would require making the column nullable (muddies the semantics of a heavily-used table) or inventing sentinel reminders. New table keeps each table's meaning single: "a per-reminder notification fired" vs "a periodic digest fired."

## Queries (`lib/digests/queries.ts`)

```ts
type DigestItem = {
  reminderId: string;
  title: string;
  dueOn: Date;            // earliest target nextDueOn per reminder
  daysOverdue: number;    // 0 for weekly items not yet overdue
  targets: Array<{ kind: 'item' | 'system'; id: string; name: string }>;
};

export async function getOverdueForUser(userId: string, timezone: string): Promise<DigestItem[]>;
export async function getWeeklyForUser(userId: string, timezone: string): Promise<DigestItem[]>;
```

- **Overdue:** rows where `ReminderTarget.nextDueOn < startOfToday(timezone)` and `Reminder.active = true` and `userId ∈ Reminder.notifyUserIds`. Sorted by `nextDueOn` ASC (most-overdue first).
- **Weekly:** rows where `ReminderTarget.nextDueOn` ∈ `[now, now + 7 days]` and `Reminder.active = true` and `userId ∈ Reminder.notifyUserIds`. Sorted by `nextDueOn` ASC.

A reminder can have multiple targets; one `DigestItem` per `(reminder, target)` keeps the flat-list UX honest. Empty result → handler skips with `'nothing to report'`.

Queries return the flat `DigestItem` projection only — no leaked Prisma relation shapes. Same purity discipline as `ReminderEmailData` in [[project-outbound-email-templates-status]].

## Template (`lib/email/templates/digest.tsx`)

```ts
export type DigestItem = { /* … same as queries */ };
export type DigestEmailData = {
  mode: 'overdue' | 'weekly';
  items: DigestItem[];  // already sorted by the query; the template never re-sorts
  appUrl: string;       // guaranteed non-empty by the handler's APP_URL guard
  timezone: string;
};
export type DigestEmailResult = { subject: string; html: string; text: string };

export function digestEmail(data: DigestEmailData): DigestEmailResult;
```

| Element | Source |
|---|---|
| Subject (`overdue`) | `Overdue: {N} reminder${pluralize}` (count-aware) |
| Subject (`weekly`) | `This week: {N} reminder${pluralize} due` |
| H1 in body | `Overdue reminders` / `Reminders due this week` |
| Item list (flat, ordered as given) | per-item: title linked to `{appUrl}/reminders/{id}`; sub-line: target name(s) linked to `/items/{id}` or `/systems/{id}`; badge: `{daysOverdue}d overdue` (overdue mode) or `due {formatDue}` (weekly mode, formatted in supplied `timezone`) |
| Footer | "Manage notification settings" → `{appUrl}/settings` (via `Layout`) |

Reuses `Layout` + `EMAIL_TOKENS` from `lib/email/layout.tsx`. Inline styles only (no `<style>`, no classes) — same email-client-safety contract as `reminderEmail`. Same `appUrl` trailing-slash normalization at the entry point (`data.appUrl.replace(/\/+$/, '')`). Empty `items` is a programming error (the handler skips before calling the template) — defensive `throw new Error('digestEmail requires non-empty items; handler should have skipped')`.

## Settings UI

New section in `app/(app)/settings/page.tsx`, rendered alongside the existing notification prefs:

```
─── Digest emails ──────────────────────────────────────────
[ ] Send an overdue digest at  [08:00 ▾]  daily
[ ] Send a weekly summary on   [Monday ▾] at [08:00 ▾]
```

- Two toggles map to `overdueDigestEnabled` / `weeklySummaryEnabled`.
- Hour pickers are 24-entry `<select>` (`00:00`, `01:00`, …, `23:00`) → store the integer hour.
- Day picker is `Sunday`…`Saturday` → store 0…6.
- Time pickers are disabled when their toggle is off.
- Server action persists via the same path the existing prefs use (updates `User.notificationPrefs` Json column; validated by the extended Zod schema on the way in).
- Follow the [[feedback-ui-shadcn]] discipline: shadcn primitives, not native HTML. **Match the existing `NotificationPrefsForm` idiom**: that form already uses `<Checkbox>` (not `<Switch>`) for toggles and `<Select>` for enumerated choices. One form, one idiom — extend with the same primitives.

## Testing

Mirrors the per-layer discipline from PR #148.

### Unit — `lib/email/templates/digest.test.ts`

- Subject for both modes, count-aware pluralization.
- H1 wording per mode.
- Flat list rendered in supplied order (template never re-sorts).
- Per-item links absolute and correct; target sub-line renders both item and system targets.
- `{N}d overdue` badge in overdue mode; `due {formatted date}` in weekly mode, formatted in supplied tz.
- Both `html` and `text` returned and non-empty; `text` is structured (not HTML-stripped).
- HTML escaping of titles to prevent injection (same shape as `reminderEmail` injection test).
- **No `<style>` tag and no `class=`/`className=` in rendered output** (the per-template safety pattern).
- `appUrl` trailing-slash normalization (e.g. `https://hm.example/` → single-slash hrefs).
- `digestEmail({mode, items: []})` throws.

### Unit — `lib/notifications/prefs.test.ts` (extend)

- Five new Zod fields validate (in-range hours/days, defaults applied).
- `readNotificationPrefs(null)` produces all new defaults (`enabled: false`).

### Integration — `lib/digests/queries.test.ts` (Testcontainers)

- `getOverdueForUser`: returns rows where `nextDueOn < startOfToday(tz)`; excludes inactive reminders; respects tz boundary (a row at `2026-05-20T23:00Z` is "yesterday" in `America/Los_Angeles` and "today" in `Europe/London`); sort is most-overdue-first; returns `[]` when nothing matches; respects `notifyUserIds`.
- `getWeeklyForUser`: window is `[now, now + 7d]`; sort ascending; `[]` when empty; same active + notifyUserIds discipline.

### Integration — `tests/integration/digest-tick.test.ts` (Testcontainers)

For each of overdue and weekly paths:
- (a) **Happy path:** user's hour matches; query non-empty → `sendEmail` called once with expected subject + content; `DigestLog` row `status='sent'`.
- (b) **Dedup:** running the tick twice in the same hour → only one send; second tick finds the existing `DigestLog` row and skips.
- (c) **Disabled:** `…Enabled=false` → no send, no `DigestLog` row.
- (d) **Empty result:** query returns `[]` → `sendEmail` NOT called; `DigestLog { status: 'skipped', errorReason: 'nothing to report' }`.
- (e) **`APP_URL` unset:** `vi.mocked(getEnv).mockReturnValueOnce(...)` returns no `APP_URL` → `sendEmail` NOT called; `DigestLog { status: 'skipped', errorReason: 'APP_URL not configured' }`.

Uses the same `vi.mock('@/lib/notifications/email', ...)` capture-then-assert pattern as `notify-job.test.ts`. Same `vi.mock('@/lib/env', ...)` with `mockReturnValueOnce` for the unset path. Reuses the [[project-outbound-email-templates-status]] test scaffolding.

### Settings UI

Whether to add an E2E for the new settings section depends on whether one exists today for the existing notification prefs. If yes, extend it. If no, the plan calls out adding a focused E2E that toggles the new section and asserts persistence. Otherwise covered by the unit prefs tests + manual smoke.

## Risks & mitigations

- **Tick clock skew:** worker host clock vs `notificationPrefs.timezone` math. Mitigation: handler computes "now in user tz" exclusively via `Intl.DateTimeFormat` (the same primitive `lib/email/templates/reminder.tsx` already uses for `formatDue`) — no new dependency. Tests cover tz boundary cases.
- **Long-running query at scale:** N+1 risk if `getOverdueForUser` does naive nested fetches. Mitigation: queries use a single `findMany` with `include` (one round trip per query). Documented in code.
- **DigestLog growth:** unbounded over time. Mitigation: defer — same shape as `NotificationLog` (which is also unbounded today; the existing `NotifyLogSweep` job is the precedent for any future cleanup).
- **User changes their tz between schedule write and tick:** existing handler reads tz at tick time, not at write time, so the next tick picks up the new tz automatically. No special handling needed.
- **Dedup race across two parallel ticks:** unique-constraint catch is the dedup primitive; concurrent ticks race into one winner, the loser sees the conflict and treats it as "already sent." Same pattern as `notify.ts`.

## Out of scope / future

- Per-`ReminderKind` template variants → separate Spec B.
- Grouping by day or by kind inside the digest → can be added later behind a pref if you want it; flat is enough for now.
- Digest push notifications (push channel for the same content) → not in scope; this is explicitly an *email* digest.
- Digest cleanup sweep (analogous to `NotifyLogSweep`) → defer until the table grows.
- One-click-from-digest "snooze" or "mark all complete" actions → would require signed-token endpoints, same auth-surface concern as PR #148.
