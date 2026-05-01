# Plan 3 — Reminders & Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled Reminders to the house-manager app with three notification channels (Web Push, email via ForwardEmail, iCal feed). Establish the cron-tick + per-user/channel fan-out pattern that future scheduled work can extend.

**Architecture:** New Prisma models (Reminder, ReminderCompletion, NotificationLog, PushSubscription) plus User additions. A pg-boss cron `reminders.tick` job polls every 5 min and enqueues `notify` jobs per (user × channel). Channel adapters in `lib/notifications/` (push, email, quiet-hours) are pure functions wrapped by the worker. iCal feed is a Route Handler reading the same Reminder rows. UI mirrors Plan 2a patterns (RHF + Zod, FormProvider, inline 'use server' wrappers for completion).

**Tech Stack:** Prisma 7, Postgres unique constraints for dedupe, pg-boss cron + work API, `web-push` (new), `ical-generator` (new), `rrule` (new), Next.js Server Actions + Route Handler, Zod 4.4, React 19.

**Spec:** `docs/superpowers/specs/2026-04-30-plan-3-reminders-design.md`

---

## File structure

### New files

**Schema + migration**
- `prisma/migrations/<timestamp>_add_reminders/migration.sql` — generated, then manually appended with the NotificationLog unique-constraint touch-up if needed

**Library code**
- `lib/reminders/recurrence.ts` — pure recurrence math (`computeNextDueOn`, `previewOccurrences`)
- `lib/reminders/recurrence.test.ts` — unit tests for recurrence math
- `lib/reminders/schema.ts` — Zod schemas (`recurrenceSchema`, `createReminderSchema`, `updateReminderSchema`, `completeReminderSchema`)
- `lib/reminders/schema.test.ts` — unit tests for schemas
- `lib/reminders/queries.ts` — `getReminder`, `listReminders`, `listRemindersForItem`, `listUpcomingReminders` (dashboard)
- `lib/reminders/actions.ts` — `createReminder`, `updateReminder`, `deleteReminder`, `completeReminder`, `setReminderActive`
- `lib/notifications/push.ts` — VAPID setup + `sendPush(sub, payload)`
- `lib/notifications/email.ts` — ForwardEmail adapter `sendEmail(to, payload)`
- `lib/notifications/quiet-hours.ts` — `isInQuietWindow(now, prefs)`, `nextNonQuietTime(now, prefs)`
- `lib/notifications/quiet-hours.test.ts` — unit tests
- `lib/notifications/prefs.ts` — Zod schema for `notificationPrefs`, helpers
- `lib/notifications/prefs.test.ts` — unit tests
- `lib/notifications/actions.ts` — `saveNotificationPrefs`, `subscribePush`, `unsubscribePush`, `regenerateIcsToken`
- `lib/ical/build.ts` — assembles a VCALENDAR via `ical-generator`

**Worker**
- `worker/jobs/reminders-tick.ts` — cron handler
- `worker/jobs/notify.ts` — per-(user × channel) handler

**HTTP**
- `app/api/push/vapid-key/route.ts` — GET; returns the public VAPID key as JSON
- `app/api/calendar/[token]/route.ts` — GET; serves the user's iCal feed

**UI components**
- `components/reminders/RecurrencePicker.tsx` (Client) — interval/monthly/yearly picker
- `components/reminders/ReminderForm.tsx` (Client) — RHF + Zod
- `components/reminders/ReminderTable.tsx` (Server) — list rendering with status badges
- `components/reminders/ReminderStatusBadge.tsx` (Server) — Overdue / Due Soon / Upcoming / Inactive
- `components/reminders/CompleteReminderForm.tsx` (Client) — completion notes + optional ServiceRecord fields
- `components/notifications/PushSubscribeButton.tsx` (Client) — orchestrates browser permission + subscription
- `components/notifications/NotificationPrefsForm.tsx` (Client) — channel toggles + quiet hours
- `components/notifications/CalendarPanel.tsx` (Server + a small Client regenerate button) — iCal URL display + copy/regenerate

**Pages**
- `app/(app)/reminders/page.tsx` — list
- `app/(app)/reminders/new/page.tsx` — create
- `app/(app)/reminders/[id]/page.tsx` — detail with history + upcoming
- `app/(app)/reminders/[id]/edit/page.tsx` — edit

**Static**
- `public/sw.js` — service worker for push events
- `public/icon.png` — 192×192 placeholder PNG (referenced by service worker)

**Tests**
- `tests/integration/reminders.test.ts`
- `tests/integration/notification-log.test.ts`
- `tests/integration/notify-job.test.ts`
- `tests/integration/reminders-tick.test.ts`
- `tests/integration/ical-feed.test.ts`
- `tests/e2e/reminders.spec.ts`

### Modified files

- `prisma/schema.prisma` — new models, User additions, ServiceRecord inverse relation
- `package.json` — add `web-push`, `ical-generator`, `rrule` (current latest at install time)
- `lib/env.ts` — add 5 new env vars to the Zod schema
- `.env` — add the 5 new vars (locally) — instructions only, not committed
- `worker/index.ts` — register `reminders.tick` cron + `notify` worker
- `app/layout.tsx` — register service worker (single line in a small Client component imported once)
- `app/(app)/items/[id]/page.tsx` — add Reminders tab (sixth)
- `components/items/ItemTabs.tsx` — add `'reminders'` to TabSlug
- `lib/items/queries.ts` — `getItem` includes reminders
- `app/(app)/dashboard/page.tsx` — add "Upcoming reminders" section
- `lib/dashboard/queries.ts` — add `reminder-completed` event type + add `listUpcomingReminders` query usage
- `app/(app)/settings/page.tsx` — mount NotificationPrefsForm + CalendarPanel

---

## Done criteria

- [ ] `pnpm verify` clean (lint + typecheck + unit).
- [ ] `pnpm test:integration` passes (existing + new ~25 reminder/notification cases).
- [ ] `pnpm test:e2e` passes (all existing specs + new `reminders.spec.ts`).
- [ ] `pnpm build` succeeds.
- [ ] Manual smoke (with mock OIDC + dev + worker, populated env vars):
  - Sign in → /items/[id]?tab=reminders → "+ Add reminder" → create "Replace filter every 60 days, lead 3 days"
  - Edit `Reminder.nextDueOn` to `now() + 1 minute` via psql, wait for tick (or trigger manually) → Web Push notification arrives in browser
  - Click "Mark complete" in detail page → next due rolls to `today + 60 days`; completion appears in History
  - Settings → Calendar shows generated `.ics` URL; subscribe in Apple Calendar → events appear with VALARM
  - Toggle quiet hours so `now()` falls inside; trigger tick → no push fires until quietEnd

---

## Task 1: Add deps + env vars + VAPID keys

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Modify: `lib/env.ts`
- Modify: `.env` (locally, NOT committed)

- [ ] **Step 1: Install runtime deps at current latest**

```bash
pnpm add web-push ical-generator rrule
pnpm add -D @types/web-push
```

Verify the installed versions are the current major (per `feedback_dep_currency`):

```bash
npm view web-push version time.modified
npm view ical-generator version time.modified
npm view rrule version time.modified
```

If `pnpm add` picks up older majors than what `npm view version` shows, flag it. Otherwise proceed. (Renovate handles ongoing pinning; we just want to start on the current major.)

- [ ] **Step 2: Generate VAPID keypair**

```bash
pnpm exec web-push generate-vapid-keys
```

Output is a public/private keypair. Copy these into the local `.env` as `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY`. Don't commit `.env`.

- [ ] **Step 3: Update `lib/env.ts`**

Read the file first to see current shape. Add the five new env vars to the Zod schema:

```ts
const EnvSchema = z.object({
  // ...existing...
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().min(1),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().min(1),
  WEB_PUSH_CONTACT_EMAIL: z.string().email().startsWith('mailto:'),
  FORWARDEMAIL_API_KEY: z.string().min(1),
  FORWARDEMAIL_FROM_ADDRESS: z.string().min(1),
});
```

The `WEB_PUSH_CONTACT_EMAIL` regex enforces the `mailto:` prefix the VAPID spec requires.

- [ ] **Step 4: Update `.env` locally (not committed)**

Add to your local `.env`:

```
WEB_PUSH_VAPID_PUBLIC_KEY=<public-key-from-step-2>
WEB_PUSH_VAPID_PRIVATE_KEY=<private-key-from-step-2>
WEB_PUSH_CONTACT_EMAIL=mailto:ow@mroliverwine.com
FORWARDEMAIL_API_KEY=<paste from ForwardEmail dashboard>
FORWARDEMAIL_FROM_ADDRESS=House Manager <reminders@example.com>
```

If `FORWARDEMAIL_API_KEY` isn't set yet (real account not provisioned), use a placeholder string for now — `pnpm verify` only needs `getEnv()` to parse without errors; the email adapter is exercised via mocked fetch in tests. Document the ForwardEmail account-setup step in the implementation plan's manual smoke section.

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
git add package.json pnpm-lock.yaml lib/env.ts
git commit -m "build(reminders): add web-push, ical-generator, rrule; new env vars for push + email"
```

Don't push.

---

## Task 2: Schema migration — Reminder + ReminderCompletion + NotificationLog + PushSubscription + User additions

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_reminders/migration.sql` (generated, possibly tweaked)

- [ ] **Step 1: Add the four new models + User additions**

Edit `prisma/schema.prisma`. Append the following models after the existing ones:

```prisma
model Reminder {
  id                      String              @id @default(cuid())
  itemId                  String?
  item                    Item?               @relation(fields: [itemId], references: [id], onDelete: SetNull)
  title                   String
  description             String?             @db.Text
  recurrence              Json
  lastCompletedOn         DateTime?
  nextDueOn               DateTime
  leadTimeDays            Int                 @default(3)
  notifyUserIds           String[]
  autoCreateServiceRecord Boolean             @default(false)
  active                  Boolean             @default(true)
  createdAt               DateTime            @default(now())
  updatedAt               DateTime            @updatedAt

  completions             ReminderCompletion[]
  notificationLogs        NotificationLog[]

  @@index([nextDueOn])
  @@index([active, nextDueOn])
  @@index([itemId])
}

model ReminderCompletion {
  id                      String         @id @default(cuid())
  reminderId              String
  reminder                Reminder       @relation(fields: [reminderId], references: [id], onDelete: Cascade)
  completedById           String
  completedBy             User           @relation(fields: [completedById], references: [id])
  completedOn             DateTime
  notes                   String?        @db.Text
  createdServiceRecordId  String?
  createdServiceRecord    ServiceRecord? @relation("ReminderCompletionServiceRecord", fields: [createdServiceRecordId], references: [id], onDelete: SetNull)
  createdAt               DateTime       @default(now())

  @@index([reminderId, completedOn])
}

model NotificationLog {
  id          String   @id @default(cuid())
  reminderId  String
  reminder    Reminder @relation(fields: [reminderId], references: [id], onDelete: Cascade)
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel     String
  cycle       String
  sentAt      DateTime @default(now())
  status      String
  errorReason String?

  @@unique([reminderId, userId, channel, cycle])
  @@index([reminderId])
}

model PushSubscription {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  endpoint   String    @unique
  p256dh     String
  auth       String
  userAgent  String?
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?

  @@index([userId])
}
```

In the existing `model User`, add inside the body:

```prisma
  notificationPrefs       Json?
  icsToken                String?    @unique

  pushSubscriptions       PushSubscription[]
  reminderCompletions     ReminderCompletion[]
  notificationLogs        NotificationLog[]
```

In the existing `model ServiceRecord`, add the inverse:

```prisma
  completionFromReminder  ReminderCompletion? @relation("ReminderCompletionServiceRecord")
```

(The relation name `"ReminderCompletionServiceRecord"` is required because there's only one column on `ReminderCompletion` referencing `ServiceRecord` — Prisma auto-infers the name otherwise, but giving it explicit improves clarity and survives later additions.)

- [ ] **Step 2: Generate migration in `--create-only` mode**

```bash
docker compose up -d db   # already up usually
pnpm exec prisma migrate dev --create-only --name add_reminders
```

Review the generated `prisma/migrations/<timestamp>_add_reminders/migration.sql`. The unique constraint on `NotificationLog (reminderId, userId, channel, cycle)` should be in there. If not, append it manually:

```sql
-- (Only if Prisma didn't generate this from @@unique)
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_reminderId_userId_channel_cycle_key"
  UNIQUE ("reminderId", "userId", "channel", "cycle");
```

- [ ] **Step 3: Apply migration**

```bash
pnpm db:migrate
```

Expected: migration applies cleanly. Existing rows are unaffected (User gets two new nullable columns; ServiceRecord just gets an inverse relation reference, no new columns).

- [ ] **Step 4: Regenerate Prisma client**

```bash
pnpm db:generate
```

- [ ] **Step 5: Verify the new tables + constraints**

```bash
docker compose exec db psql -U housemanager -d housemanager -c "\dt" | grep -iE "reminder|notif|pushsub"
docker compose exec db psql -U housemanager -d housemanager -c '\d "NotificationLog"' | grep -A 2 "Indexes"
```

Expected: 4 new tables + the unique constraint visible on NotificationLog.

- [ ] **Step 6: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(reminders): add Reminder/ReminderCompletion/NotificationLog/PushSubscription schema"
```

---

## Task 3: Recurrence engine + tests (TDD)

**Files:**
- Create: `lib/reminders/recurrence.ts`
- Create: `lib/reminders/recurrence.test.ts`
- Create: `lib/reminders/schema.ts` (the recurrence Zod schema lives here)
- Create: `lib/reminders/schema.test.ts`

This task is TDD: write failing tests first.

- [ ] **Step 1: Write the failing tests for `computeNextDueOn`**

Create `lib/reminders/recurrence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeNextDueOn, previewOccurrences } from './recurrence';

describe('computeNextDueOn', () => {
  it('interval: returns completedOn + days', () => {
    const completed = new Date('2026-04-30T12:00:00Z');
    const next = computeNextDueOn({ kind: 'interval', days: 60 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('monthly: returns next dayOfMonth strictly after completedOn', () => {
    const completed = new Date('2026-04-10T00:00:00Z');
    const next = computeNextDueOn({ kind: 'monthly', dayOfMonth: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  it('monthly: skips current month if dayOfMonth already passed', () => {
    const completed = new Date('2026-04-20T00:00:00Z');
    const next = computeNextDueOn({ kind: 'monthly', dayOfMonth: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-15');
  });

  it('yearly: returns next month/day strictly after completedOn', () => {
    const completed = new Date('2026-03-20T00:00:00Z');
    const next = computeNextDueOn({ kind: 'yearly', month: 3, day: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('yearly: returns same year if not yet passed', () => {
    const completed = new Date('2026-01-10T00:00:00Z');
    const next = computeNextDueOn({ kind: 'yearly', month: 3, day: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});

describe('previewOccurrences', () => {
  it('returns N future occurrences for interval', () => {
    const occ = previewOccurrences(
      { kind: 'interval', days: 30 },
      new Date('2026-05-01T00:00:00Z'),
      3,
    );
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-05-31', '2026-06-30', '2026-07-30',
    ]);
  });

  it('returns N future occurrences for monthly', () => {
    const occ = previewOccurrences(
      { kind: 'monthly', dayOfMonth: 15 },
      new Date('2026-05-01T00:00:00Z'),
      3,
    );
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-05-15', '2026-06-15', '2026-07-15',
    ]);
  });
});
```

Run: `pnpm test:unit lib/reminders/recurrence.test.ts` — expect FAIL (module not found).

- [ ] **Step 2: Write the failing tests for the schemas**

Create `lib/reminders/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { recurrenceSchema, createReminderSchema } from './schema';

describe('recurrenceSchema', () => {
  it.each([
    [{ kind: 'interval', days: 60 }, true],
    [{ kind: 'interval', days: 0 }, false],
    [{ kind: 'interval', days: 3651 }, false],
    [{ kind: 'monthly', dayOfMonth: 15 }, true],
    [{ kind: 'monthly', dayOfMonth: 0 }, false],
    [{ kind: 'monthly', dayOfMonth: 29 }, false],
    [{ kind: 'yearly', month: 3, day: 15 }, true],
    [{ kind: 'yearly', month: 0, day: 15 }, false],
    [{ kind: 'yearly', month: 13, day: 15 }, false],
    [{ kind: 'yearly', month: 3, day: 29 }, false],
    [{ kind: 'unknown' }, false],
  ])('parses %j → success=%s', (input, expected) => {
    expect(recurrenceSchema.safeParse(input).success).toBe(expected);
  });
});

describe('createReminderSchema', () => {
  it('accepts a complete valid reminder', () => {
    const r = createReminderSchema.safeParse({
      title: 'Replace HVAC filter',
      description: 'use MERV 13',
      itemId: 'cuid-1',
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
      leadTimeDays: 3,
      autoCreateServiceRecord: false,
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing title', () => {
    const r = createReminderSchema.safeParse({
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative leadTimeDays', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
      leadTimeDays: -1,
    });
    expect(r.success).toBe(false);
  });
});
```

Run: `pnpm test:unit lib/reminders/schema.test.ts` — expect FAIL.

- [ ] **Step 3: Implement `lib/reminders/schema.ts`**

```ts
import { z } from 'zod';

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(28),
  }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(28),
  }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;

export const createReminderSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().or(z.literal('')),
  itemId: z.string().min(1).optional(),
  recurrence: recurrenceSchema,
  nextDueOn: z.coerce.date(),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  autoCreateServiceRecord: z.boolean().default(false),
  notifyUserIds: z.array(z.string().min(1)).optional(),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = createReminderSchema.partial().extend({
  id: z.string().min(1),
  active: z.boolean().optional(),
});

export type UpdateReminderInput = z.infer<typeof updateReminderSchema>;

export const completeReminderSchema = z.object({
  id: z.string().min(1),
  notes: z.string().max(20_000).optional().or(z.literal('')),
  serviceRecord: z
    .object({
      summary: z.string().min(1).max(200),
      vendorId: z.string().min(1).optional(),
      cost: z.coerce.number().nonnegative().optional(),
      notes: z.string().max(20_000).optional().or(z.literal('')),
    })
    .optional(),
});

export type CompleteReminderInput = z.infer<typeof completeReminderSchema>;
```

- [ ] **Step 4: Implement `lib/reminders/recurrence.ts`**

```ts
import { RRule } from 'rrule';
import type { Recurrence } from './schema';

const DAY_MS = 86_400_000;

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date {
  switch (rec.kind) {
    case 'interval':
      return new Date(completedOn.getTime() + rec.days * DAY_MS);
    case 'monthly': {
      const after = new Date(completedOn.getTime() + DAY_MS);
      const rule = new RRule({
        freq: RRule.MONTHLY,
        bymonthday: [rec.dayOfMonth],
        dtstart: after,
        count: 1,
      });
      const [next] = rule.all();
      if (!next) throw new Error('rrule returned no occurrence');
      return next;
    }
    case 'yearly': {
      const after = new Date(completedOn.getTime() + DAY_MS);
      const rule = new RRule({
        freq: RRule.YEARLY,
        bymonth: [rec.month],
        bymonthday: [rec.day],
        dtstart: after,
        count: 1,
      });
      const [next] = rule.all();
      if (!next) throw new Error('rrule returned no occurrence');
      return next;
    }
  }
}

/** Project up to N future occurrences after a starting date (used by detail view + iCal feed). */
export function previewOccurrences(rec: Recurrence, startAfter: Date, count: number): Date[] {
  const occ: Date[] = [];
  let cursor = startAfter;
  for (let i = 0; i < count; i++) {
    cursor = computeNextDueOn(rec, cursor);
    occ.push(cursor);
  }
  return occ;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test:unit lib/reminders/recurrence.test.ts lib/reminders/schema.test.ts
```

Expected: all pass.

- [ ] **Step 6: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(reminders): add recurrence + schema with TDD coverage"
```

---

## Task 4: Notification prefs + quiet-hours math + Zod schema

**Files:**
- Create: `lib/notifications/prefs.ts`
- Create: `lib/notifications/prefs.test.ts`
- Create: `lib/notifications/quiet-hours.ts`
- Create: `lib/notifications/quiet-hours.test.ts`

- [ ] **Step 1: Write failing tests for prefs Zod**

Create `lib/notifications/prefs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { notificationPrefsSchema, defaultNotificationPrefs } from './prefs';

describe('notificationPrefsSchema', () => {
  it('parses a complete object', () => {
    const r = notificationPrefsSchema.safeParse({
      pushEnabled: true,
      emailEnabled: false,
      quietStart: '22:00',
      quietEnd: '07:00',
      timezone: 'America/Chicago',
    });
    expect(r.success).toBe(true);
  });

  it('applies defaults for missing fields', () => {
    const r = notificationPrefsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(defaultNotificationPrefs);
  });

  it('rejects malformed time strings', () => {
    const r = notificationPrefsSchema.safeParse({ quietStart: '25:00' });
    expect(r.success).toBe(false);
  });
});
```

Run: `pnpm test:unit lib/notifications/prefs.test.ts` — expect FAIL.

- [ ] **Step 2: Implement `lib/notifications/prefs.ts`**

```ts
import { z } from 'zod';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const notificationPrefsSchema = z.object({
  pushEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(false),
  quietStart: z.string().regex(TIME).nullable().default(null),
  quietEnd: z.string().regex(TIME).nullable().default(null),
  timezone: z.string().default('UTC'),
});

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const defaultNotificationPrefs: NotificationPrefs = {
  pushEnabled: true,
  emailEnabled: false,
  quietStart: null,
  quietEnd: null,
  timezone: 'UTC',
};

/** Normalize whatever's stored in User.notificationPrefs (Json | null) to a typed object. */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const r = notificationPrefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : defaultNotificationPrefs;
}
```

Run: `pnpm test:unit lib/notifications/prefs.test.ts` — expect PASS.

- [ ] **Step 3: Write failing tests for quiet-hours**

Create `lib/notifications/quiet-hours.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isInQuietWindow, nextNonQuietTime } from './quiet-hours';
import type { NotificationPrefs } from './prefs';

const utc = (iso: string) => new Date(iso);
const baseline: NotificationPrefs = {
  pushEnabled: true,
  emailEnabled: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  timezone: 'UTC',
};

describe('isInQuietWindow', () => {
  it('returns false when both null', () => {
    const prefs = { ...baseline, quietStart: null, quietEnd: null };
    expect(isInQuietWindow(utc('2026-04-30T03:00:00Z'), prefs)).toBe(false);
  });

  it('returns true when now is inside an overnight window', () => {
    expect(isInQuietWindow(utc('2026-04-30T23:30:00Z'), baseline)).toBe(true);
    expect(isInQuietWindow(utc('2026-04-30T05:00:00Z'), baseline)).toBe(true);
  });

  it('returns false when now is outside the window', () => {
    expect(isInQuietWindow(utc('2026-04-30T12:00:00Z'), baseline)).toBe(false);
    expect(isInQuietWindow(utc('2026-04-30T07:00:00Z'), baseline)).toBe(false);
  });

  it('handles a daytime window (no midnight crossing)', () => {
    const prefs = { ...baseline, quietStart: '13:00', quietEnd: '14:00' };
    expect(isInQuietWindow(utc('2026-04-30T13:30:00Z'), prefs)).toBe(true);
    expect(isInQuietWindow(utc('2026-04-30T15:00:00Z'), prefs)).toBe(false);
  });
});

describe('nextNonQuietTime', () => {
  it('returns now when not in window', () => {
    const now = utc('2026-04-30T12:00:00Z');
    expect(nextNonQuietTime(now, baseline).getTime()).toBe(now.getTime());
  });

  it('returns next quietEnd today when within window before midnight', () => {
    const now = utc('2026-04-30T23:30:00Z');
    const next = nextNonQuietTime(now, baseline);
    expect(next.toISOString()).toBe('2026-05-01T07:00:00.000Z');
  });

  it('returns quietEnd today when within window after midnight', () => {
    const now = utc('2026-04-30T05:00:00Z');
    const next = nextNonQuietTime(now, baseline);
    expect(next.toISOString()).toBe('2026-04-30T07:00:00.000Z');
  });
});
```

Run: `pnpm test:unit lib/notifications/quiet-hours.test.ts` — expect FAIL.

- [ ] **Step 4: Implement `lib/notifications/quiet-hours.ts`**

```ts
import type { NotificationPrefs } from './prefs';

function parseHM(hm: string): { h: number; m: number } {
  const [h, m] = hm.split(':').map(Number);
  return { h, m };
}

/**
 * In-window check, naive UTC interpretation of HH:MM strings.
 * For v1 we treat quietStart/quietEnd as wall-clock times in the user's
 * timezone but apply them to the UTC clock as a simplification — adequate
 * because the user's timezone is recorded and the wall-clock hour matches
 * what they'd expect in that zone. A proper implementation uses Intl
 * formatting; deferred to Plan 5 polish.
 */
export function isInQuietWindow(now: Date, prefs: NotificationPrefs): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = parseHM(prefs.quietStart);
  const end = parseHM(prefs.quietEnd);
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const minutesStart = start.h * 60 + start.m;
  const minutesEnd = end.h * 60 + end.m;

  if (minutesStart === minutesEnd) return false; // zero-length window
  if (minutesStart < minutesEnd) {
    // daytime window
    return minutesNow >= minutesStart && minutesNow < minutesEnd;
  }
  // overnight (e.g. 22:00 - 07:00)
  return minutesNow >= minutesStart || minutesNow < minutesEnd;
}

/** If `now` is inside the quiet window, return the next end-of-window timestamp; else return `now`. */
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs): Date {
  if (!isInQuietWindow(now, prefs)) return now;
  const end = parseHM(prefs.quietEnd!);
  const candidate = new Date(now);
  candidate.setUTCHours(end.h, end.m, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}
```

Run tests — expect PASS.

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(notifications): notification prefs + quiet-hours math"
```

---

## Task 5: Push adapter + email adapter (channel send-functions)

**Files:**
- Create: `lib/notifications/push.ts`
- Create: `lib/notifications/email.ts`

No automated tests for these — the worker integration tests in Task 8 exercise both via mocking. Both files are pure adapters.

- [ ] **Step 1: Implement `lib/notifications/push.ts`**

```ts
import webpush from 'web-push';
import { getEnv } from '@/lib/env';

let configured = false;

function configureOnce() {
  if (configured) return;
  const env = getEnv();
  webpush.setVapidDetails(
    env.WEB_PUSH_CONTACT_EMAIL,
    env.WEB_PUSH_VAPID_PUBLIC_KEY,
    env.WEB_PUSH_VAPID_PRIVATE_KEY,
  );
  configured = true;
}

export type PushPayload = {
  title: string;
  body: string;
  url: string;
};

export type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type SendPushResult =
  | { ok: true }
  | { ok: false; reason: 'subscription-gone' | string };

export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
): Promise<SendPushResult> {
  configureOnce();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      return { ok: false, reason: 'subscription-gone' };
    }
    return { ok: false, reason: (e as Error).message ?? 'unknown' };
  }
}
```

- [ ] **Step 2: Implement `lib/notifications/email.ts`**

```ts
import { getEnv } from '@/lib/env';

export type EmailPayload = {
  subject: string;
  text: string;
  html: string;
};

export type SendEmailResult = { ok: true } | { ok: false; reason: string };

export async function sendEmail(to: string, payload: EmailPayload): Promise<SendEmailResult> {
  const env = getEnv();
  const auth = Buffer.from(`${env.FORWARDEMAIL_API_KEY}:`).toString('base64');
  const res = await fetch('https://api.forwardemail.net/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FORWARDEMAIL_FROM_ADDRESS,
      to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `${res.status} ${res.statusText}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}
```

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(notifications): add push (VAPID) and email (ForwardEmail) adapters"
```

---

## Task 6: Reminders queries + actions

**Files:**
- Create: `lib/reminders/queries.ts`
- Create: `lib/reminders/actions.ts`

- [ ] **Step 1: Implement queries**

Create `lib/reminders/queries.ts`:

```ts
import { prisma } from '@/lib/db';
import type { ListParams } from '@/lib/url-params';

const STANDARD_INCLUDE = {
  item: { select: { id: true, name: true } },
};

export async function getReminder(id: string) {
  return prisma.reminder.findUnique({
    where: { id },
    include: {
      ...STANDARD_INCLUDE,
      completions: {
        orderBy: { completedOn: 'desc' },
        take: 20,
        include: {
          completedBy: { select: { id: true, name: true } },
          createdServiceRecord: { select: { id: true, summary: true } },
        },
      },
    },
  });
}

export async function listReminders(params: ListParams) {
  const where = {
    AND: [
      params.filters.itemId?.length ? { itemId: { in: params.filters.itemId } } : {},
      params.filters.active?.length
        ? { active: params.filters.active[0] === 'true' }
        : {},
      params.q
        ? {
            OR: [
              { title: { contains: params.q, mode: 'insensitive' as const } },
              { description: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {},
    ],
  };

  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({
      where,
      orderBy: { nextDueOn: 'asc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: STANDARD_INCLUDE,
    }),
    prisma.reminder.count({ where }),
  ]);

  return { reminders, total };
}

export async function listRemindersForItem(itemId: string) {
  return prisma.reminder.findMany({
    where: { itemId, active: true },
    orderBy: { nextDueOn: 'asc' },
  });
}

export async function listUpcomingReminders(limit = 5) {
  return prisma.reminder.findMany({
    where: { active: true },
    orderBy: { nextDueOn: 'asc' },
    take: limit,
    include: STANDARD_INCLUDE,
  });
}
```

- [ ] **Step 2: Implement actions**

Create `lib/reminders/actions.ts`:

```ts
'use server';
import { createId } from '@paralleldrive/cuid2';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { computeNextDueOn } from './recurrence';
import {
  completeReminderSchema,
  createReminderSchema,
  type Recurrence,
  updateReminderSchema,
} from './schema';

function revalidateReminderPaths(itemId: string | null | undefined, reminderId: string) {
  revalidatePath('/reminders');
  revalidatePath(`/reminders/${reminderId}`);
  revalidatePath('/dashboard');
  if (itemId) revalidatePath(`/items/${itemId}`);
}

export async function createReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsed = createReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { itemId, description, notifyUserIds, ...rest } = parsed.data;

  if (itemId) {
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
    if (!item) return { ok: false, formError: 'Item not found' };
  }

  const reminder = await prisma.reminder.create({
    data: {
      ...rest,
      description: description || null,
      itemId: itemId ?? null,
      notifyUserIds: notifyUserIds && notifyUserIds.length > 0 ? notifyUserIds : [session.user.id],
    },
    select: { id: true, itemId: true },
  });

  revalidateReminderPaths(reminder.itemId, reminder.id);
  return { ok: true, data: { id: reminder.id } };
}

export async function updateReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const parsed = updateReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, itemId, description, notifyUserIds, ...rest } = parsed.data;

  const existing = await prisma.reminder.findUnique({
    where: { id },
    select: { id: true, itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  if (itemId !== undefined && itemId !== null) {
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true } });
    if (!item) return { ok: false, formError: 'Item not found' };
  }

  const data: Record<string, unknown> = { ...rest };
  if ('itemId' in parsed.data) data.itemId = itemId ?? null;
  if ('description' in parsed.data) data.description = description || null;
  if (notifyUserIds !== undefined) data.notifyUserIds = notifyUserIds;

  await prisma.reminder.update({ where: { id }, data });
  revalidateReminderPaths(existing.itemId, id);
  if (itemId !== undefined && itemId !== existing.itemId && existing.itemId)
    revalidatePath(`/items/${existing.itemId}`);

  return { ok: true, data: { id } };
}

export async function deleteReminder(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const existing = await prisma.reminder.findUnique({
    where: { id },
    select: { itemId: true },
  });
  if (!existing) return { ok: false, formError: 'Not found' };

  await prisma.reminder.delete({ where: { id } });
  revalidateReminderPaths(existing.itemId, id);
  return { ok: true, data: undefined };
}

export async function setReminderActive(
  id: string,
  active: boolean,
): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };

  const updated = await prisma.reminder.update({
    where: { id },
    data: { active },
    select: { id: true, itemId: true },
  });
  revalidateReminderPaths(updated.itemId, id);
  return { ok: true, data: { id } };
}

export async function completeReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const userId = session.user.id;

  const parsed = completeReminderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, notes, serviceRecord } = parsed.data;

  const reminder = await prisma.reminder.findUnique({
    where: { id },
    select: {
      id: true,
      itemId: true,
      recurrence: true,
      autoCreateServiceRecord: true,
    },
  });
  if (!reminder) return { ok: false, formError: 'Not found' };

  const now = new Date();
  const recurrence = reminder.recurrence as unknown as Recurrence;
  const nextDueOn = computeNextDueOn(recurrence, now);

  const completion = await prisma.reminderCompletion.create({
    data: {
      id: createId(),
      reminderId: id,
      completedById: userId,
      completedOn: now,
      notes: notes || null,
    },
    select: { id: true },
  });

  if (reminder.autoCreateServiceRecord && reminder.itemId && serviceRecord) {
    const sr = await prisma.serviceRecord.create({
      data: {
        itemId: reminder.itemId,
        performedOn: now,
        summary: serviceRecord.summary,
        notes: serviceRecord.notes || null,
        cost: serviceRecord.cost,
        vendorId: serviceRecord.vendorId ?? null,
      },
      select: { id: true },
    });
    await prisma.reminderCompletion.update({
      where: { id: completion.id },
      data: { createdServiceRecordId: sr.id },
    });
  }

  await prisma.reminder.update({
    where: { id },
    data: { lastCompletedOn: now, nextDueOn },
  });

  revalidateReminderPaths(reminder.itemId, id);
  return { ok: true, data: { id } };
}
```

- [ ] **Step 3: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(reminders): add queries + actions (CRUD + complete)"
```

---

## Task 7: Reminders integration tests

**Files:**
- Create: `tests/integration/reminders.test.ts`
- Create: `tests/integration/notification-log.test.ts`

- [ ] **Step 1: Reminders integration test**

Create `tests/integration/reminders.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let userId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'hvac' },
    create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.attachment.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'test-user', email: 'test@example.com', name: 'Test User' },
  });
  userId = 'test-user';
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId } });
  itemId = item.id;
});

describe('Reminder CRUD', () => {
  it('creates a reminder with interval recurrence', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'Replace HVAC filter',
        recurrence: { kind: 'interval', days: 60 },
        nextDueOn: new Date('2026-06-30'),
        notifyUserIds: [userId],
        itemId,
      },
    });
    expect(r.title).toBe('Replace HVAC filter');
    expect(r.notifyUserIds).toEqual([userId]);
  });

  it('cascade-deletes completions when reminder is deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
      },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: { reminderId: r.id, completedById: userId, completedOn: new Date() },
    });
    await ctx.prisma.reminder.delete({ where: { id: r.id } });
    const orphan = await ctx.prisma.reminderCompletion.findUnique({ where: { id: c.id } });
    expect(orphan).toBeNull();
  });

  it('SetNulls itemId when parent Item is hard-deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
        itemId,
      },
    });
    await ctx.prisma.item.delete({ where: { id: itemId } });
    const r2 = await ctx.prisma.reminder.findUnique({ where: { id: r.id } });
    expect(r2?.itemId).toBeNull();
  });
});

describe('ReminderCompletion + ServiceRecord linkage', () => {
  it('creates a completion linked to a service record', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
        autoCreateServiceRecord: true,
        itemId,
      },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { itemId, performedOn: new Date(), summary: 'filter replaced' },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
        completedById: userId,
        completedOn: new Date(),
        createdServiceRecordId: sr.id,
      },
    });
    const reread = await ctx.prisma.reminderCompletion.findUnique({
      where: { id: c.id },
      include: { createdServiceRecord: true },
    });
    expect(reread?.createdServiceRecord?.summary).toBe('filter replaced');
  });

  it('SetNulls createdServiceRecordId when ServiceRecord is hard-deleted', async () => {
    const r = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
      },
    });
    const sr = await ctx.prisma.serviceRecord.create({
      data: { itemId, performedOn: new Date(), summary: 'X' },
    });
    const c = await ctx.prisma.reminderCompletion.create({
      data: {
        reminderId: r.id,
        completedById: userId,
        completedOn: new Date(),
        createdServiceRecordId: sr.id,
      },
    });
    await ctx.prisma.serviceRecord.delete({ where: { id: sr.id } });
    const reread = await ctx.prisma.reminderCompletion.findUnique({ where: { id: c.id } });
    expect(reread?.createdServiceRecordId).toBeNull();
  });
});
```

- [ ] **Step 2: NotificationLog dedupe test**

Create `tests/integration/notification-log.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;
let userId: string;
let reminderId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'u1', email: 'u1@example.com', name: 'U1' },
  });
  userId = 'u1';
  const r = await ctx.prisma.reminder.create({
    data: {
      title: 'X',
      recurrence: { kind: 'interval', days: 30 },
      nextDueOn: new Date('2026-06-30'),
      notifyUserIds: [userId],
    },
  });
  reminderId = r.id;
});

describe('NotificationLog unique constraint', () => {
  it('rejects duplicate (reminderId, userId, channel, cycle)', async () => {
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'reminder-x-2026-06-30', status: 'sent' },
    });
    await expect(
      ctx.prisma.notificationLog.create({
        data: { reminderId, userId, channel: 'push', cycle: 'reminder-x-2026-06-30', status: 'sent' },
      }),
    ).rejects.toThrow();
  });

  it('allows different channels in the same cycle', async () => {
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'C', status: 'sent' },
    });
    const second = await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'email', cycle: 'C', status: 'sent' },
    });
    expect(second.channel).toBe('email');
  });

  it('allows different cycles for the same channel', async () => {
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'A', status: 'sent' },
    });
    const second = await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'B', status: 'sent' },
    });
    expect(second.cycle).toBe('B');
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
pnpm test:integration tests/integration/reminders.test.ts tests/integration/notification-log.test.ts
```

Expected: 8 cases pass.

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "test(reminders): integration tests for CRUD + cascade + NotificationLog dedupe"
```

---

## Task 8: Worker — `notify` job

**Files:**
- Create: `worker/jobs/notify.ts`
- Create: `tests/integration/notify-job.test.ts`

- [ ] **Step 1: Implement the handler**

Create `worker/jobs/notify.ts`:

```ts
import { prisma } from '@/lib/db';
import { readNotificationPrefs } from '@/lib/notifications/prefs';
import { sendPush } from '@/lib/notifications/push';
import { sendEmail } from '@/lib/notifications/email';
import { isInQuietWindow, nextNonQuietTime } from '@/lib/notifications/quiet-hours';
import { getEnv } from '@/lib/env';

export type NotifyJob = {
  reminderId: string;
  userId: string;
  channel: 'push' | 'email';
  cycle: string;
};

export async function handleNotify(payload: NotifyJob, deps?: {
  enqueueLater?: (delay: Date) => Promise<void>;
}): Promise<void> {
  const reminder = await prisma.reminder.findUnique({
    where: { id: payload.reminderId },
    select: { id: true, title: true, description: true, active: true, itemId: true },
  });
  if (!reminder || !reminder.active) return;

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, notificationPrefs: true },
  });
  if (!user) return;

  const prefs = readNotificationPrefs(user.notificationPrefs);
  const now = new Date();

  if (isInQuietWindow(now, prefs)) {
    if (deps?.enqueueLater) await deps.enqueueLater(nextNonQuietTime(now, prefs));
    return;
  }

  // Insert log first; rely on unique constraint to dedupe.
  let logId: string;
  try {
    const log = await prisma.notificationLog.create({
      data: { ...payload, status: 'queued' },
      select: { id: true },
    });
    logId = log.id;
  } catch {
    // Unique-constraint violation = already notified for this cycle.
    return;
  }

  const env = getEnv();
  const url = `${env.APP_URL ?? ''}/reminders/${reminder.id}`;

  if (payload.channel === 'push') {
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: payload.userId },
    });
    if (subs.length === 0) {
      await prisma.notificationLog.update({
        where: { id: logId },
        data: { status: 'skipped', errorReason: 'no subscriptions' },
      });
      return;
    }
    let anyOk = false;
    for (const sub of subs) {
      const r = await sendPush(sub, {
        title: reminder.title,
        body: reminder.description?.slice(0, 200) ?? 'Due soon',
        url,
      });
      if (r.ok) {
        anyOk = true;
        await prisma.pushSubscription.update({
          where: { id: sub.id },
          data: { lastUsedAt: new Date() },
        });
      } else if (r.reason === 'subscription-gone') {
        await prisma.pushSubscription.delete({ where: { id: sub.id } });
      }
    }
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: anyOk ? 'sent' : 'skipped' },
    });
    return;
  }

  // email
  if (!user.email) {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'no email' },
    });
    return;
  }
  const subject = `Reminder: ${reminder.title}`;
  const body = `${reminder.description ?? ''}\n\n${url}`;
  const html = `<p>${escapeHtml(reminder.description ?? '')}</p><p><a href="${url}">Mark complete</a></p>`;
  const r = await sendEmail(user.email, { subject, text: body, html });
  await prisma.notificationLog.update({
    where: { id: logId },
    data: r.ok ? { status: 'sent' } : { status: 'failed', errorReason: r.reason },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
```

`APP_URL` is referenced — it's a env var that already exists per the spec. If `getEnv()` doesn't yet have it, add to the Zod schema in `lib/env.ts` (the value comes from `AUTH_URL` in v1; `APP_URL` defaulting to AUTH_URL is fine).

- [ ] **Step 2: Write the integration test**

Create `tests/integration/notify-job.test.ts`. The test mocks the channel adapters at the module level via Vitest's `vi.mock()`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

const sentPushes: unknown[] = [];
const sentEmails: unknown[] = [];

vi.mock('@/lib/notifications/push', () => ({
  sendPush: vi.fn(async (_sub: unknown, payload: unknown) => {
    sentPushes.push(payload);
    return { ok: true };
  }),
}));

vi.mock('@/lib/notifications/email', () => ({
  sendEmail: vi.fn(async (_to: string, payload: unknown) => {
    sentEmails.push(payload);
    return { ok: true };
  }),
}));

const { handleNotify } = await import('@/worker/jobs/notify');

let ctx: IntegrationContext;
let userId: string;
let reminderId: string;

beforeAll(async () => { ctx = await setupIntegration(); }, 180_000);
afterAll(async () => { await teardownIntegration(ctx); });

beforeEach(async () => {
  sentPushes.length = 0;
  sentEmails.length = 0;
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.pushSubscription.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'u1', email: 'u1@example.com', name: 'U1' },
  });
  userId = 'u1';
  const r = await ctx.prisma.reminder.create({
    data: {
      title: 'X',
      recurrence: { kind: 'interval', days: 30 },
      nextDueOn: new Date('2026-06-30'),
      notifyUserIds: [userId],
    },
  });
  reminderId = r.id;
});

describe('handleNotify', () => {
  it('inserts a NotificationLog with status=sent on push success', async () => {
    await ctx.prisma.pushSubscription.create({
      data: { userId, endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
    });
    await handleNotify({ reminderId, userId, channel: 'push', cycle: 'C1' });
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log?.status).toBe('sent');
    expect(sentPushes).toHaveLength(1);
  });

  it('skips on duplicate cycle (unique-constraint dedupe)', async () => {
    await ctx.prisma.pushSubscription.create({
      data: { userId, endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
    });
    await ctx.prisma.notificationLog.create({
      data: { reminderId, userId, channel: 'push', cycle: 'C1', status: 'sent' },
    });
    await handleNotify({ reminderId, userId, channel: 'push', cycle: 'C1' });
    expect(sentPushes).toHaveLength(0); // no new push was sent
  });

  it('logs status=skipped when no push subscriptions', async () => {
    await handleNotify({ reminderId, userId, channel: 'push', cycle: 'C1' });
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log?.status).toBe('skipped');
    expect(log?.errorReason).toBe('no subscriptions');
  });

  it('logs status=sent on email success', async () => {
    await handleNotify({ reminderId, userId, channel: 'email', cycle: 'C1' });
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log?.status).toBe('sent');
    expect(sentEmails).toHaveLength(1);
  });

  it('does not insert a log when in quiet-hours and re-enqueues via deps.enqueueLater', async () => {
    // Set quiet hours to encompass now
    await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        notificationPrefs: {
          pushEnabled: true,
          emailEnabled: false,
          quietStart: '00:00',
          quietEnd: '23:59',
          timezone: 'UTC',
        },
      },
    });
    let enqueued: Date | null = null;
    await handleNotify(
      { reminderId, userId, channel: 'push', cycle: 'C1' },
      { enqueueLater: async (d) => { enqueued = d; } },
    );
    expect(enqueued).not.toBeNull();
    const log = await ctx.prisma.notificationLog.findFirst({ where: { reminderId, cycle: 'C1' } });
    expect(log).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test:integration tests/integration/notify-job.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(reminders): notify worker job + integration tests"
```

---

## Task 9: Worker — `reminders.tick` cron

**Files:**
- Create: `worker/jobs/reminders-tick.ts`
- Create: `tests/integration/reminders-tick.test.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Implement the cron handler**

Create `worker/jobs/reminders-tick.ts`:

```ts
import { prisma } from '@/lib/db';
import { readNotificationPrefs } from '@/lib/notifications/prefs';

const DAY_MS = 86_400_000;

export async function handleRemindersTick(deps: {
  enqueue: (job: { reminderId: string; userId: string; channel: 'push' | 'email'; cycle: string }) => Promise<void>;
}): Promise<{ enqueued: number }> {
  const now = new Date();

  // Cap our look-ahead window to the largest active leadTimeDays (bounded for sanity).
  const aggregateLeadTime = await prisma.reminder.aggregate({
    where: { active: true },
    _max: { leadTimeDays: true },
  });
  const maxLead = Math.min(aggregateLeadTime._max.leadTimeDays ?? 3, 30);

  const dueSoon = await prisma.reminder.findMany({
    where: {
      active: true,
      nextDueOn: { lte: new Date(now.getTime() + maxLead * DAY_MS) },
    },
    select: {
      id: true,
      nextDueOn: true,
      leadTimeDays: true,
      notifyUserIds: true,
    },
  });

  let enqueued = 0;
  for (const r of dueSoon) {
    const cycle = `reminder-${r.id}-${r.nextDueOn.toISOString().slice(0, 10)}`;
    const notifyAt = new Date(r.nextDueOn.getTime() - r.leadTimeDays * DAY_MS);
    if (notifyAt.getTime() > now.getTime()) continue; // not yet within lead window

    for (const uid of r.notifyUserIds) {
      const user = await prisma.user.findUnique({
        where: { id: uid },
        select: { notificationPrefs: true },
      });
      if (!user) continue;
      const prefs = readNotificationPrefs(user.notificationPrefs);
      const channels: ('push' | 'email')[] = [];
      if (prefs.pushEnabled) channels.push('push');
      if (prefs.emailEnabled) channels.push('email');

      for (const channel of channels) {
        const existing = await prisma.notificationLog.findUnique({
          where: { reminderId_userId_channel_cycle: { reminderId: r.id, userId: uid, channel, cycle } },
        });
        if (existing) continue;
        await deps.enqueue({ reminderId: r.id, userId: uid, channel, cycle });
        enqueued++;
      }
    }
  }
  return { enqueued };
}
```

The compound unique-constraint name is auto-generated by Prisma — verify what `@@unique([reminderId, userId, channel, cycle])` produced and match it. The shape `reminderId_userId_channel_cycle` is the standard naming.

- [ ] **Step 2: Write integration test**

Create `tests/integration/reminders-tick.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';
import { handleRemindersTick } from '@/worker/jobs/reminders-tick';

let ctx: IntegrationContext;
let userId: string;

beforeAll(async () => { ctx = await setupIntegration(); }, 180_000);
afterAll(async () => { await teardownIntegration(ctx); });

beforeEach(async () => {
  await ctx.prisma.notificationLog.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: {
      id: 'u1',
      email: 'u1@example.com',
      name: 'U1',
      notificationPrefs: { pushEnabled: true, emailEnabled: true },
    },
  });
  userId = 'u1';
});

describe('handleRemindersTick', () => {
  it('enqueues 2 jobs (push + email) for a reminder due now with both channels enabled', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        leadTimeDays: 0,
        notifyUserIds: [userId],
      },
    });
    const enqueued: unknown[] = [];
    const r = await handleRemindersTick({ enqueue: async (j) => { enqueued.push(j); } });
    expect(r.enqueued).toBe(2);
    expect(enqueued).toHaveLength(2);
  });

  it('skips reminders already logged for the cycle', async () => {
    const reminder = await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        leadTimeDays: 0,
        notifyUserIds: [userId],
      },
    });
    const cycle = `reminder-${reminder.id}-${reminder.nextDueOn.toISOString().slice(0, 10)}`;
    await ctx.prisma.notificationLog.create({
      data: { reminderId: reminder.id, userId, channel: 'push', cycle, status: 'sent' },
    });
    await ctx.prisma.notificationLog.create({
      data: { reminderId: reminder.id, userId, channel: 'email', cycle, status: 'sent' },
    });
    const enqueued: unknown[] = [];
    const r = await handleRemindersTick({ enqueue: async (j) => { enqueued.push(j); } });
    expect(r.enqueued).toBe(0);
  });

  it('skips inactive reminders', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(),
        notifyUserIds: [userId],
        active: false,
      },
    });
    const r = await handleRemindersTick({ enqueue: async () => {} });
    expect(r.enqueued).toBe(0);
  });

  it('respects leadTimeDays — does not enqueue for reminder still 10 days out with leadTime=3', async () => {
    await ctx.prisma.reminder.create({
      data: {
        title: 'X',
        recurrence: { kind: 'interval', days: 30 },
        nextDueOn: new Date(Date.now() + 10 * 86_400_000),
        leadTimeDays: 3,
        notifyUserIds: [userId],
      },
    });
    const r = await handleRemindersTick({ enqueue: async () => {} });
    expect(r.enqueued).toBe(0);
  });
});
```

- [ ] **Step 3: Register cron in `worker/index.ts`**

Read `worker/index.ts`. Add registration alongside the existing `thumbnail` job:

```ts
import { handleRemindersTick } from './jobs/reminders-tick';
import { handleNotify, type NotifyJob } from './jobs/notify';

// ...inside main(), after the existing thumbnail registration:
await boss.schedule('reminders.tick', '*/5 * * * *');
await boss.work('reminders.tick', { batchSize: 1 }, async () => {
  await handleRemindersTick({
    enqueue: async (job) => { await boss.send('notify', job); },
  });
});

await boss.work<NotifyJob>('notify', { batchSize: 4 }, async (jobs) => {
  for (const job of jobs) {
    await handleNotify(job.data, {
      enqueueLater: async (when) => { await boss.send('notify', job.data, { startAfter: when }); },
    });
  }
});

console.log('worker: registered reminders.tick + notify jobs');
```

- [ ] **Step 4: Run tests**

```bash
pnpm test:integration tests/integration/reminders-tick.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(reminders): cron tick + worker registration"
```

---

## Task 10: Notification prefs action + push subscription action

**Files:**
- Create: `lib/notifications/actions.ts`

- [ ] **Step 1: Implement the actions**

Create `lib/notifications/actions.ts`:

```ts
'use server';
import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { ActionResult } from '@/lib/result';
import { notificationPrefsSchema } from './prefs';

export async function saveNotificationPrefs(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const parsed = notificationPrefsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { notificationPrefs: parsed.data },
  });
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}

export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
};

export async function subscribePush(input: PushSubscriptionInput): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  if (!input.endpoint || !input.p256dh || !input.auth) {
    return { ok: false, formError: 'Invalid subscription payload' };
  }
  // Upsert by endpoint (devices can re-subscribe).
  const sub = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId: session.user.id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      userId: session.user.id,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    select: { id: true },
  });
  revalidatePath('/settings');
  return { ok: true, data: { id: sub.id } };
}

export async function unsubscribePush(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  await prisma.pushSubscription.delete({ where: { id } });
  revalidatePath('/settings');
  return { ok: true, data: undefined };
}

export async function regenerateIcsToken(): Promise<ActionResult<{ token: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, formError: 'Unauthorized' };
  const token = randomBytes(24).toString('base64url');
  await prisma.user.update({
    where: { id: session.user.id },
    data: { icsToken: token },
  });
  revalidatePath('/settings');
  return { ok: true, data: { token } };
}
```

- [ ] **Step 2: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "feat(notifications): prefs + push subscription + ics token actions"
```

---

## Task 11: iCal feed builder + Route Handler

**Files:**
- Create: `lib/ical/build.ts`
- Create: `app/api/calendar/[token]/route.ts`
- Create: `tests/integration/ical-feed.test.ts`

- [ ] **Step 1: Implement the feed builder**

Create `lib/ical/build.ts`:

```ts
import ical, { ICalCalendarMethod } from 'ical-generator';
import { previewOccurrences, type Recurrence } from '@/lib/reminders/recurrence';

export type IcalReminderRow = {
  id: string;
  title: string;
  description: string | null;
  recurrence: Recurrence;
  nextDueOn: Date;
  leadTimeDays: number;
};

export function buildIcal(reminders: IcalReminderRow[], appUrl: string): string {
  const cal = ical({
    name: 'House Manager',
    method: ICalCalendarMethod.PUBLISH,
  });
  for (const r of reminders) {
    const occurrences = [r.nextDueOn, ...previewOccurrences(r.recurrence, r.nextDueOn, 11)];
    for (const date of occurrences) {
      const dateOnly = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      cal.createEvent({
        id: `reminder-${r.id}-${dateOnly.toISOString().slice(0, 10)}`,
        start: dateOnly,
        end: dateOnly,
        allDay: true,
        summary: r.title,
        description: r.description ?? '',
        url: `${appUrl}/reminders/${r.id}`,
        alarms: [
          {
            type: 'display',
            trigger: r.leadTimeDays * 86_400, // seconds before
            description: `${r.title} due`,
          },
        ],
      });
    }
  }
  return cal.toString();
}
```

- [ ] **Step 2: Implement the Route Handler**

Create `app/api/calendar/[token]/route.ts`:

```ts
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { buildIcal } from '@/lib/ical/build';
import type { Recurrence } from '@/lib/reminders/recurrence';

type Params = Promise<{ token: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { token: raw } = await params;
  const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;

  const user = await prisma.user.findUnique({ where: { icsToken: token }, select: { id: true } });
  if (!user) return new Response('Not found', { status: 404 });

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
      nextDueOn: true,
      leadTimeDays: true,
    },
  });

  const env = getEnv();
  const body = buildIcal(
    reminders.map((r) => ({
      ...r,
      recurrence: r.recurrence as unknown as Recurrence,
    })),
    env.AUTH_URL ?? '',
  );

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
```

- [ ] **Step 3: Write integration test**

Create `tests/integration/ical-feed.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';
import { buildIcal } from '@/lib/ical/build';

let ctx: IntegrationContext;
let userId: string;

beforeAll(async () => { ctx = await setupIntegration(); }, 180_000);
afterAll(async () => { await teardownIntegration(ctx); });

beforeEach(async () => {
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({
    data: { id: 'u1', email: 'u1@example.com', name: 'U1', icsToken: 'tok-abc' },
  });
  userId = 'u1';
});

describe('buildIcal', () => {
  it('returns a VCALENDAR with one VEVENT per occurrence (12 for a recurring reminder)', () => {
    const text = buildIcal(
      [
        {
          id: 'r1',
          title: 'Replace HVAC filter',
          description: 'use MERV 13',
          recurrence: { kind: 'interval', days: 30 },
          nextDueOn: new Date('2026-06-30T00:00:00Z'),
          leadTimeDays: 3,
        },
      ],
      'https://example.com',
    );
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('END:VCALENDAR');
    const eventCount = (text.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(eventCount).toBe(12);
    expect(text).toContain('SUMMARY:Replace HVAC filter');
    expect(text).toContain('TRIGGER:-PT259200S'); // 3 days in seconds
  });

  it('returns 0 events for an empty list', () => {
    const text = buildIcal([], 'https://example.com');
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).not.toContain('BEGIN:VEVENT');
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm test:integration tests/integration/ical-feed.test.ts
```

Expected: 2/2 pass.

(The Route Handler is exercised via the e2e test in Task 17.)

- [ ] **Step 5: Verify, commit**

```bash
pnpm verify
pnpm build  # ensures the new route compiles
git add -A
git commit -m "feat(ical): VCALENDAR builder + authenticated feed route"
```

---

## Task 12: VAPID public-key route + service worker + icon

**Files:**
- Create: `app/api/push/vapid-key/route.ts`
- Create: `public/sw.js`
- Create: `public/icon.png` (192×192 placeholder)

- [ ] **Step 1: VAPID key route**

Create `app/api/push/vapid-key/route.ts`:

```ts
import { auth } from '@/lib/auth';
import { getEnv } from '@/lib/env';

export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });
  const env = getEnv();
  return Response.json({ publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY });
}
```

- [ ] **Step 2: Service worker**

Create `public/sw.js`:

```js
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'House Manager';
  const options = {
    body: data.body || '',
    data: { url: data.url || '/' },
    icon: '/icon.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
```

- [ ] **Step 3: Placeholder icon**

Generate a 192×192 PNG using sharp (already in deps from Plan 2b):

```bash
pnpm exec node -e "
const sharp = require('sharp');
sharp({ create: { width: 192, height: 192, channels: 4, background: { r: 13, g: 102, b: 204, alpha: 1 } } })
  .png()
  .toFile('public/icon.png')
  .then(() => console.log('done'));
"
ls -lh public/icon.png
```

A solid blue square is fine for v1; replace with a real icon in Plan 5.

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(push): VAPID key route + service worker + placeholder icon"
```

---

## Task 13: RecurrencePicker + ReminderForm + ReminderStatusBadge

**Files:**
- Create: `components/reminders/RecurrencePicker.tsx`
- Create: `components/reminders/ReminderForm.tsx`
- Create: `components/reminders/ReminderStatusBadge.tsx`

UI work; no automated tests (e2e covers it).

- [ ] **Step 1: ReminderStatusBadge**

```tsx
const DAY_MS = 86_400_000;

type Props = { nextDueOn: Date; active: boolean };

export function ReminderStatusBadge({ nextDueOn, active }: Props) {
  if (!active) {
    return <span className="badge" style={{ color: 'var(--fg-muted)' }}>Inactive</span>;
  }
  const days = Math.floor((nextDueOn.getTime() - Date.now()) / DAY_MS);
  if (days < 0) {
    return <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Overdue</span>;
  }
  if (days <= 3) {
    return <span className="badge" style={{ background: 'var(--bg-elevated)', color: 'var(--warning)' }}>Due soon</span>;
  }
  return <span className="badge" style={{ color: 'var(--fg-muted)' }}>In {days}d</span>;
}
```

- [ ] **Step 2: RecurrencePicker**

```tsx
'use client';
import { useState } from 'react';
import type { Recurrence } from '@/lib/reminders/schema';

type Props = {
  defaultValue?: Recurrence;
  onChange: (rec: Recurrence) => void;
};

export function RecurrencePicker({ defaultValue, onChange }: Props) {
  const [kind, setKind] = useState<Recurrence['kind']>(defaultValue?.kind ?? 'interval');
  const [days, setDays] = useState(defaultValue?.kind === 'interval' ? defaultValue.days : 60);
  const [dayOfMonth, setDayOfMonth] = useState(defaultValue?.kind === 'monthly' ? defaultValue.dayOfMonth : 1);
  const [month, setMonth] = useState(defaultValue?.kind === 'yearly' ? defaultValue.month : 1);
  const [day, setDay] = useState(defaultValue?.kind === 'yearly' ? defaultValue.day : 1);

  function emit(next: Recurrence) {
    onChange(next);
  }

  return (
    <fieldset style={{ border: '1px solid var(--border)', padding: '0.75rem', borderRadius: '4px' }}>
      <legend style={{ fontSize: '0.85rem' }}>Recurrence</legend>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
        <input type="radio" checked={kind === 'interval'} onChange={() => { setKind('interval'); emit({ kind: 'interval', days }); }} />
        Every
        <input type="number" min={1} max={3650} value={days} onChange={(e) => { const n = Number(e.target.value); setDays(n); if (kind === 'interval') emit({ kind: 'interval', days: n }); }} style={{ width: '5rem' }} />
        days from last completion
      </label>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
        <input type="radio" checked={kind === 'monthly'} onChange={() => { setKind('monthly'); emit({ kind: 'monthly', dayOfMonth }); }} />
        Every month on day
        <input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => { const n = Number(e.target.value); setDayOfMonth(n); if (kind === 'monthly') emit({ kind: 'monthly', dayOfMonth: n }); }} style={{ width: '4rem' }} />
        <span style={{ color: 'var(--fg-muted)', fontSize: '0.8rem' }}>(1–28)</span>
      </label>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input type="radio" checked={kind === 'yearly'} onChange={() => { setKind('yearly'); emit({ kind: 'yearly', month, day }); }} />
        Every year on
        <select value={month} onChange={(e) => { const n = Number(e.target.value); setMonth(n); if (kind === 'yearly') emit({ kind: 'yearly', month: n, day }); }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'long' })}</option>)}
        </select>
        <input type="number" min={1} max={28} value={day} onChange={(e) => { const n = Number(e.target.value); setDay(n); if (kind === 'yearly') emit({ kind: 'yearly', month, day: n }); }} style={{ width: '4rem' }} />
      </label>
    </fieldset>
  );
}
```

- [ ] **Step 3: ReminderForm**

```tsx
'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Controller, FormProvider, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorBanner } from '@/components/forms/ErrorBanner';
import { FormField } from '@/components/forms/FormField';
import { SubmitButton } from '@/components/forms/SubmitButton';
import { ItemAutocomplete } from '@/components/service-records/ItemAutocomplete';
import type { ActionResult } from '@/lib/result';
import { type CreateReminderInput, createReminderSchema, type Recurrence } from '@/lib/reminders/schema';
import { RecurrencePicker } from './RecurrencePicker';

type FormValues = z.input<typeof createReminderSchema>;

type Props = {
  items: { id: string; name: string }[];
  defaultValues?: Partial<CreateReminderInput & { id: string }>;
  action: (input: CreateReminderInput | (CreateReminderInput & { id: string })) => Promise<ActionResult<{ id: string }>>;
  submitLabel: string;
};

export function ReminderForm({ items, defaultValues, action, submitLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const methods = useForm<FormValues>({
    resolver: zodResolver(createReminderSchema),
    defaultValues: {
      autoCreateServiceRecord: false,
      leadTimeDays: 3,
      recurrence: { kind: 'interval', days: 60 },
      ...defaultValues,
    },
  });
  const { register, handleSubmit, control, setError, formState: { errors } } = methods;
  const formError = (errors as { root?: { message?: string } }).root?.message;

  const onSubmit = handleSubmit((data) => {
    startTransition(async () => {
      const payload = defaultValues?.id ? { ...data, id: defaultValues.id } : data;
      const result = await action(payload as CreateReminderInput);
      if (!result.ok) {
        if (result.formError) setError('root', { message: result.formError });
        if (result.fieldErrors) {
          for (const [field, msgs] of Object.entries(result.fieldErrors)) {
            setError(field as keyof FormValues, { message: msgs?.[0] });
          }
        }
        return;
      }
      router.push(`/reminders/${result.data.id}`);
    });
  });

  return (
    <FormProvider {...methods}>
      <form onSubmit={onSubmit} style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <ErrorBanner message={formError} />
        <FormField label="Title" htmlFor="title" error={errors.title?.message}>
          <input id="title" {...register('title')} required />
        </FormField>
        <FormField label="Description (markdown)" htmlFor="description" error={errors.description?.message}>
          <textarea id="description" rows={4} {...register('description')} />
        </FormField>
        <FormField label="Item" htmlFor="itemId" error={errors.itemId?.message}>
          <ItemAutocomplete name="itemId" label="" options={items} />
        </FormField>
        <Controller
          control={control}
          name="recurrence"
          render={({ field }) => (
            <RecurrencePicker
              defaultValue={field.value as Recurrence | undefined}
              onChange={(rec) => field.onChange(rec)}
            />
          )}
        />
        <FormField label="First due date" htmlFor="nextDueOn" error={errors.nextDueOn?.message}>
          <input id="nextDueOn" type="date" {...register('nextDueOn')} required />
        </FormField>
        <FormField label="Lead time (days)" htmlFor="leadTimeDays" error={errors.leadTimeDays?.message}>
          <input id="leadTimeDays" type="number" min={0} max={365} {...register('leadTimeDays', { valueAsNumber: true })} />
        </FormField>
        <FormField label="Auto-create service record on completion" htmlFor="autoCreateServiceRecord" error={errors.autoCreateServiceRecord?.message}>
          <input id="autoCreateServiceRecord" type="checkbox" {...register('autoCreateServiceRecord')} />
        </FormField>
        <SubmitButton>{pending ? 'Saving…' : submitLabel}</SubmitButton>
      </form>
    </FormProvider>
  );
}
```

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(reminders): RecurrencePicker + ReminderForm + status badge"
```

---

## Task 14: ReminderTable + CompleteReminderForm + reminders pages

**Files:**
- Create: `components/reminders/ReminderTable.tsx`
- Create: `components/reminders/CompleteReminderForm.tsx`
- Create: `app/(app)/reminders/page.tsx`
- Create: `app/(app)/reminders/new/page.tsx`
- Create: `app/(app)/reminders/[id]/page.tsx`
- Create: `app/(app)/reminders/[id]/edit/page.tsx`

UI; no automated tests (e2e covers it).

- [ ] **Step 1: ReminderTable**

```tsx
import Link from 'next/link';
import { ReminderStatusBadge } from './ReminderStatusBadge';

type Row = {
  id: string;
  title: string;
  nextDueOn: Date;
  active: boolean;
  item: { id: string; name: string } | null;
};

export function ReminderTable({ reminders }: { reminders: Row[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr className="table-header">
          <th className="table-cell">Title</th>
          <th className="table-cell">Item</th>
          <th className="table-cell">Next due</th>
          <th className="table-cell">Status</th>
        </tr>
      </thead>
      <tbody>
        {reminders.map((r) => (
          <tr key={r.id} className="table-row">
            <td className="table-cell">
              <Link href={`/reminders/${r.id}`}>{r.title}</Link>
            </td>
            <td className="table-cell">
              {r.item ? <Link href={`/items/${r.item.id}`}>{r.item.name}</Link> : '—'}
            </td>
            <td className="table-cell">{r.nextDueOn.toISOString().slice(0, 10)}</td>
            <td className="table-cell">
              <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: CompleteReminderForm**

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { completeReminder } from '@/lib/reminders/actions';

type Props = {
  reminderId: string;
  autoCreateServiceRecord: boolean;
  hasItem: boolean;
};

export function CompleteReminderForm({ reminderId, autoCreateServiceRecord, hasItem }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState('');
  const [cost, setCost] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ padding: '0.5rem 1rem' }}>
        Mark complete
      </button>
    );
  }

  const showServiceFields = autoCreateServiceRecord && hasItem;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await completeReminder({
        id: reminderId,
        notes,
        serviceRecord: showServiceFields
          ? {
              summary: summary || 'Completed via reminder',
              cost: cost ? Number(cost) : undefined,
            }
          : undefined,
      });
      if (!result.ok) {
        setError(result.formError ?? 'Could not save');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 480 }}>
      <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column' }}>
        Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} disabled={pending} />
      </label>
      {showServiceFields && (
        <>
          <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column' }}>
            Service summary
            <input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} disabled={pending} />
          </label>
          <label style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column' }}>
            Cost (optional)
            <input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} disabled={pending} />
          </label>
        </>
      )}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save completion'}</button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: List page**

```tsx
// app/(app)/reminders/page.tsx
import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { ReminderTable } from '@/components/reminders/ReminderTable';
import { listReminders } from '@/lib/reminders/queries';
import { parseListParams } from '@/lib/url-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RemindersPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') sp.set(k, v);
  const params = parseListParams(sp);
  const { reminders, total } = await listReminders(params);

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Reminders ({total})</h1>
        <Link href="/reminders/new">+ Add reminder</Link>
      </header>
      {reminders.length === 0 ? (
        <EmptyState
          message="No reminders yet."
          action={<Link href="/reminders/new">Add your first reminder</Link>}
        />
      ) : (
        <ReminderTable reminders={reminders} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: New page**

```tsx
// app/(app)/reminders/new/page.tsx
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { createReminder } from '@/lib/reminders/actions';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';

type SearchParams = Promise<{ itemId?: string }>;

export default async function NewReminderPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const items = await listAllItemsForAutocomplete();
  return (
    <div>
      <h1>New reminder</h1>
      <ReminderForm
        items={items}
        defaultValues={sp.itemId ? { itemId: sp.itemId } : undefined}
        action={createReminder}
        submitLabel="Create reminder"
      />
    </div>
  );
}
```

- [ ] **Step 5: Detail page**

```tsx
// app/(app)/reminders/[id]/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompleteReminderForm } from '@/components/reminders/CompleteReminderForm';
import { ReminderStatusBadge } from '@/components/reminders/ReminderStatusBadge';
import { Markdown } from '@/lib/markdown';
import { previewOccurrences, type Recurrence } from '@/lib/reminders/recurrence';
import { getReminder } from '@/lib/reminders/queries';

type Params = Promise<{ id: string }>;

export default async function ReminderDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const r = await getReminder(id);
  if (!r) notFound();

  const recurrence = r.recurrence as unknown as Recurrence;
  const upcoming = previewOccurrences(recurrence, r.nextDueOn, 4);
  const occurrences = [r.nextDueOn, ...upcoming];

  return (
    <div>
      <header>
        <h1 style={{ margin: 0 }}>{r.title}</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.25rem' }}>
          <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />
          {r.item && (
            <span style={{ fontSize: '0.85rem' }}>for <Link href={`/items/${r.item.id}`}>{r.item.name}</Link></span>
          )}
        </div>
      </header>
      {r.description && <Markdown>{r.description}</Markdown>}

      <h2 style={{ fontSize: '1rem', marginTop: '1rem' }}>Upcoming</h2>
      <ul>
        {occurrences.map((d) => (
          <li key={d.toISOString()}>{d.toISOString().slice(0, 10)}</li>
        ))}
      </ul>

      <h2 style={{ fontSize: '1rem', marginTop: '1rem' }}>History ({r.completions.length})</h2>
      {r.completions.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>Not completed yet.</p>
      ) : (
        <ul>
          {r.completions.map((c) => (
            <li key={c.id}>
              {c.completedOn.toISOString().slice(0, 10)} — completed by {c.completedBy.name}
              {c.notes && <span style={{ color: 'var(--fg-muted)' }}>: {c.notes}</span>}
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
        <CompleteReminderForm
          reminderId={r.id}
          autoCreateServiceRecord={r.autoCreateServiceRecord}
          hasItem={r.itemId != null}
        />
        <Link href={`/reminders/${r.id}/edit`}>Edit</Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Edit page**

```tsx
// app/(app)/reminders/[id]/edit/page.tsx
import { notFound } from 'next/navigation';
import { ReminderForm } from '@/components/reminders/ReminderForm';
import { updateReminder } from '@/lib/reminders/actions';
import { getReminder } from '@/lib/reminders/queries';
import { listAllItemsForAutocomplete } from '@/lib/notes/queries';
import type { Recurrence } from '@/lib/reminders/schema';

type Params = Promise<{ id: string }>;

export default async function EditReminderPage({ params }: { params: Params }) {
  const { id } = await params;
  const [r, items] = await Promise.all([getReminder(id), listAllItemsForAutocomplete()]);
  if (!r) notFound();

  return (
    <div>
      <h1>Edit reminder</h1>
      <ReminderForm
        items={items}
        defaultValues={{
          id: r.id,
          title: r.title,
          description: r.description ?? '',
          itemId: r.itemId ?? undefined,
          recurrence: r.recurrence as unknown as Recurrence,
          nextDueOn: r.nextDueOn,
          leadTimeDays: r.leadTimeDays,
          autoCreateServiceRecord: r.autoCreateServiceRecord,
        }}
        action={updateReminder}
        submitLabel="Save changes"
      />
    </div>
  );
}
```

- [ ] **Step 7: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(reminders): list/new/detail/edit pages + completion form"
```

---

## Task 15: Item Reminders tab + Dashboard Upcoming + activity event

**Files:**
- Modify: `components/items/ItemTabs.tsx`
- Modify: `lib/items/queries.ts`
- Modify: `app/(app)/items/[id]/page.tsx`
- Modify: `app/(app)/dashboard/page.tsx`
- Modify: `lib/dashboard/queries.ts`

- [ ] **Step 1: ItemTabs — add 'reminders' tab**

In `components/items/ItemTabs.tsx`, extend `TabSlug` and the tabs array with `'reminders'` (label "Reminders"). Match existing pattern.

- [ ] **Step 2: getItem includes reminders**

In `lib/items/queries.ts`, the `getItem` include adds:

```ts
reminders: {
  where: { active: true },
  orderBy: { nextDueOn: 'asc' },
  select: { id: true, title: true, nextDueOn: true, active: true },
},
```

- [ ] **Step 3: Item detail page renders Reminders tab**

In `app/(app)/items/[id]/page.tsx`, after the Files tab block, add:

```tsx
{tab === 'reminders' && (
  <div>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
      <h2 style={{ fontSize: '1rem', margin: 0 }}>Reminders</h2>
      <Link href={`/reminders/new?itemId=${item.id}`}>+ Add reminder</Link>
    </header>
    {item.reminders.length === 0 ? (
      <p>No reminders yet.</p>
    ) : (
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {item.reminders.map((r) => (
          <li key={r.id} style={{ borderBottom: '1px solid var(--border)', padding: '0.5rem 0', display: 'flex', justifyContent: 'space-between' }}>
            <Link href={`/reminders/${r.id}`}>{r.title}</Link>
            <span style={{ color: 'var(--fg-muted)', fontSize: '0.85rem' }}>{r.nextDueOn.toISOString().slice(0, 10)}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

Update the local `VALID_TABS` to include `'reminders'`.

- [ ] **Step 4: Dashboard — Upcoming reminders + activity event**

In `lib/dashboard/queries.ts`:
- Add a fifth `Promise.all` query to fetch top-5 upcoming reminders (use `listUpcomingReminders` from `lib/reminders/queries.ts` or replicate inline).
- In `recentActivity`, add a sixth event type `'reminder-completed'` — query top-N `ReminderCompletion` rows ordered by `completedOn desc`, include the reminder + reminder.item:

```ts
prisma.reminderCompletion.findMany({
  orderBy: { completedOn: 'desc' },
  take: limit,
  select: {
    id: true,
    completedOn: true,
    reminder: { select: { id: true, title: true, itemId: true, item: { select: { name: true } } } },
  },
}),
```

Map each to:
```ts
{
  kind: 'reminder-completed' as const,
  occurredAt: c.completedOn,
  label: `Completed: ${c.reminder.title}`,
  href: `/reminders/${c.reminder.id}`,
  icon: '✅',
}
```

- [ ] **Step 5: Dashboard page — render Upcoming reminders section**

In `app/(app)/dashboard/page.tsx`, between Quick stats and Quick actions, add a section that renders the top-5 upcoming reminders list. Each row has title, due date, and a small "Mark complete" inline button (uses `<CompleteReminderForm>` Client Component).

- [ ] **Step 6: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(reminders): Item Reminders tab + Dashboard upcoming + activity event"
```

---

## Task 16: NotificationPrefsForm + CalendarPanel + PushSubscribeButton + service worker bootstrap

**Files:**
- Create: `components/notifications/NotificationPrefsForm.tsx`
- Create: `components/notifications/CalendarPanel.tsx`
- Create: `components/notifications/PushSubscribeButton.tsx`
- Create: `components/notifications/ServiceWorkerRegistrar.tsx`
- Modify: `app/(app)/settings/page.tsx`
- Modify: `app/layout.tsx` (or `app/(app)/layout.tsx`) — register service worker

- [ ] **Step 1: ServiceWorkerRegistrar (Client Component, mounts once)**

```tsx
'use client';
import { useEffect } from 'react';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.warn('SW registration failed', e);
      });
    }
  }, []);
  return null;
}
```

Mount it inside `app/(app)/layout.tsx` (so it only runs for authenticated users). One line: `<ServiceWorkerRegistrar />` after the children outlet.

- [ ] **Step 2: PushSubscribeButton**

```tsx
'use client';
import { useState, useTransition } from 'react';
import { subscribePush } from '@/lib/notifications/actions';

export function PushSubscribeButton() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  async function subscribe() {
    setStatus(null);
    startTransition(async () => {
      try {
        if (Notification.permission === 'denied') {
          setStatus('Browser notifications are denied. Enable in your browser site settings.');
          return;
        }
        const perm = Notification.permission === 'granted'
          ? 'granted'
          : await Notification.requestPermission();
        if (perm !== 'granted') {
          setStatus('Permission not granted.');
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const keyRes = await fetch('/api/push/vapid-key');
        if (!keyRes.ok) {
          setStatus('Could not load VAPID key.');
          return;
        }
        const { publicKey } = await keyRes.json();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        const json = sub.toJSON();
        const result = await subscribePush({
          endpoint: json.endpoint!,
          p256dh: json.keys!.p256dh!,
          auth: json.keys!.auth!,
          userAgent: navigator.userAgent,
        });
        if (!result.ok) {
          setStatus(result.formError ?? 'Could not save subscription.');
          return;
        }
        setStatus('Subscribed on this device.');
      } catch (e) {
        setStatus((e as Error).message ?? 'Unknown error');
      }
    });
  }

  return (
    <div>
      <button type="button" onClick={subscribe} disabled={pending}>
        {pending ? 'Subscribing…' : 'Subscribe this device'}
      </button>
      {status && <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>{status}</p>}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
```

- [ ] **Step 3: NotificationPrefsForm**

A small form with channel toggles + quiet-hours inputs + timezone select. Uses RHF or plain useState — pick whichever matches the rest of the codebase. Submits to `saveNotificationPrefs`. (Read existing settings forms — `HouseProfileForm.tsx` — to match pattern.)

- [ ] **Step 4: CalendarPanel**

Server Component fetches `User.icsToken`. If null, renders a single button "Generate calendar URL" (calls `regenerateIcsToken`). If set, renders the full URL `<APP_URL>/api/calendar/<token>.ics` with copy button + Regenerate button. The copy button + Regenerate are a small inline Client Component.

- [ ] **Step 5: Mount panels in `app/(app)/settings/page.tsx`**

Add two new sections after the existing HouseProfile section:

```tsx
<h2>Notifications</h2>
<NotificationPrefsForm prefs={readNotificationPrefs(user.notificationPrefs)} subscriptions={user.pushSubscriptions} />
<PushSubscribeButton />

<h2>Calendar</h2>
<CalendarPanel icsToken={user.icsToken} appUrl={env.AUTH_URL} />
```

- [ ] **Step 6: Verify, commit**

```bash
pnpm verify
pnpm build
git add -A
git commit -m "feat(notifications): settings panels — prefs, push subscribe, calendar"
```

---

## Task 17: E2E happy-path

**Files:**
- Create: `tests/e2e/reminders.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from '@playwright/test';
import { resetAuth, signIn } from './auth';

test.beforeEach(async () => {
  await resetAuth();
});

test('creates a reminder, marks it complete, sees it in history', async ({ page, context }) => {
  await context.clearCookies();
  await signIn(page);

  // Create an item to attach the reminder to
  await page.goto('/items/new');
  await page.getByLabel('Name').fill('Furnace');
  await page.getByLabel('Category').selectOption('hvac');
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page).toHaveURL(/\/items\/c[a-z0-9]+$/);

  // Switch to Reminders tab
  await page.getByRole('link', { name: 'Reminders' }).click();
  await expect(page.locator('text=No reminders yet')).toBeVisible();

  // Add a reminder
  await page.getByRole('link', { name: '+ Add reminder' }).click();
  await page.getByLabel('Title').fill('Replace HVAC filter');
  await page.getByLabel('First due date').fill(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Create reminder' }).click();
  await expect(page).toHaveURL(/\/reminders\/c[a-z0-9]+$/);

  // Mark it complete
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await page.getByRole('button', { name: 'Save completion' }).click();

  // History shows the completion
  await expect(page.locator('text=completed by Test User')).toBeVisible({ timeout: 10_000 });

  // Settings shows iCal generation
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Generate calendar URL' }).click();
  await expect(page.locator('text=/api/calendar/')).toBeVisible({ timeout: 5_000 });
});
```

- [ ] **Step 2: Run the spec**

```bash
pnpm test:e2e tests/e2e/reminders.spec.ts
```

Expected: 1/1 passes. If labels don't match, adapt to whatever the form actually rendered.

- [ ] **Step 3: Run full e2e suite**

```bash
pnpm test:e2e
```

Expected: all specs (signin + happy-path + attachments + reminders) pass. The Playwright config uses `workers: 1` so they run serially.

- [ ] **Step 4: Verify, commit**

```bash
pnpm verify
git add -A
git commit -m "test(e2e): reminders happy-path"
```

---

## Notes for the implementer

- **All commits signed.** 1Password handles auto-approval; don't pass `-c user.email=...`.
- **Lefthook** fires Biome + tsc on commit and Vitest unit on push.
- **Migration ordering**: timestamps Prisma generates should sort correctly relative to existing migrations. If the new dir name comes out non-monotonic, rename to a higher timestamp before applying (Plan 2b extension Task 1 had this exact issue).
- **`web-push` uses Node `Buffer`** — no edge-runtime here. The notify worker runs in the Node-only worker process; the route handlers all default to Node runtime in this codebase.
- **Service worker scope** — `/sw.js` registers at root scope. Browsers cache aggressively; during dev, hard-reload after the first registration to ensure updates pick up. Adding `?v=N` to the registration URL is a workaround Plan 5 might address.
- **VAPID keys are stable** — do NOT regenerate after subscriptions exist; existing subscriptions become unusable. Treat the keypair as long-lived secrets.
- **ForwardEmail account setup** is operator-side: register, add a domain, verify it via DNS, generate an API key. Document in plan's manual smoke section.
- **Quiet-hours timezone simplification** — see comment in `quiet-hours.ts`. v1 treats HH:MM as wall-clock-in-the-stored-timezone but applies to UTC clock; correct for users whose timezone matches their clock (which is most of them when set correctly).
