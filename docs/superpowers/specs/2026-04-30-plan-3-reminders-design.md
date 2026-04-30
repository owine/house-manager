# Plan 3 — Reminders & Notifications

**Date:** 2026-04-30
**Status:** Draft for review
**Authors:** Oliver Wine (with Claude)
**Parent spec:** `docs/superpowers/specs/2026-04-26-house-manager-design.md`
**Builds on:** Plan 2a (CRUD) shipped 2026-04-29, Plan 2b (attachments + links) shipped 2026-04-30, Plan 2c (dark mode) shipped 2026-04-29

## Overview

Plan 3 adds the "make maintenance from being forgotten" half of the original house-manager promise: schedulable Reminders that fire notifications across three channels (Web Push, email via ForwardEmail, iCal feed) ahead of due dates. Completing a reminder rolls the schedule forward and optionally creates a ServiceRecord. A pg-boss cron tick polls every 5 minutes and fans out per (user × channel) notification jobs.

Plan 3 deliberately scopes to Reminders only — Checklists (the "Spring Maintenance" bundles in the original design) are deferred. The recurrence engine ships with three sugar flavors (interval / monthly / yearly); raw RFC 5545 RRULE strings are also deferred.

## Goals

1. Stop the user from forgetting recurring household maintenance — the app pings them ahead of due dates via channels they actually check (browser push, email, calendar).
2. Make completion a one-tap action that records what was done and rolls the next due date forward correctly.
3. Establish the scheduling-engine + notification-fan-out pattern that Plan 4 (AI-suggested reminders) and any future scheduled work can plug into.
4. Stay within the existing infrastructure — no new services, no new providers beyond a single ForwardEmail API key. pg-boss and the worker container already exist from Plan 1.

## Non-goals

- Checklists / `ChecklistRun` / `ChecklistItem` — deferred to Plan 3.5.
- Raw RFC 5545 RRULE input. The schema-level `Recurrence` discriminated union supports adding `{ kind: "anchored"; rrule: string }` later; the v1 UI exposes only the three sugar flavors.
- Multi-user UI surfaces. Schema is multi-user-ready (`Reminder.notifyUserIds` is a `String[]`, `User.notificationPrefs` is per-user) but the v1 UI assumes a single household member, defaults to that member everywhere, and hides the picker.
- AI-suggested seasonal reminders. That's Plan 4 (the original design's "Suggest" feature).
- SMS / Slack / Discord channels.
- Snooze ("remind me again in 24 hours"). Defer to a polish plan; current "complete-and-roll" plus quiet hours covers most of the use cases.
- iCal feed of past completions. The feed surfaces upcoming-only.
- Full-day-vs-time event semantics in iCal. Reminders are date-only (DTSTART;VALUE=DATE).
- Arbitrary timezone display in UI. Quiet-hours and reminder dates honor `User.notificationPrefs.timezone`; everything else is the user's browser locale.
- Service worker offline UI. The service worker exists only to receive push events.

## Architecture

Inherits Plan 1's stack and the patterns Plan 2a–2c established:

- **Postgres + Prisma 7.** New models, no rework of existing ones. One CHECK constraint added (see Schema).
- **pg-boss.** A cron job (`reminders.tick`) registered alongside the existing `thumbnail` job. New `notify` job type fans out per (user × channel).
- **web-push.** New runtime dep for VAPID-signed push delivery. Public key exposed via a route handler; subscriptions stored in a new `PushSubscription` table.
- **ForwardEmail REST API.** No SMTP; HTTP POST with API-key Basic auth. New env vars: `FORWARDEMAIL_API_KEY`, `FORWARDEMAIL_FROM_ADDRESS`.
- **iCal feed.** New runtime dep `ical-generator`. Pull-based at `/api/calendar/<token>.ics`; opaque per-user token revocable from Settings.
- **Service worker** at `public/sw.js` for receiving push events. Registered by the same Client Component that subscribes (Settings → Notifications panel).

New runtime dependencies (current latest at design time):
- `web-push` (current major; verified at install time per `feedback_dep_currency`)
- `ical-generator` (current major; same)
- `rrule` (current major; same — used internally for monthly/yearly next-occurrence math even without exposing RRULE in UI)

New env vars:
- `WEB_PUSH_VAPID_PUBLIC_KEY`
- `WEB_PUSH_VAPID_PRIVATE_KEY`
- `WEB_PUSH_CONTACT_EMAIL` (mailto: address; required by VAPID spec)
- `FORWARDEMAIL_API_KEY`
- `FORWARDEMAIL_FROM_ADDRESS` (e.g. `"House Manager <reminders@example.com>"`)
- `APP_URL` (already in use elsewhere; surfaced in email "Mark complete" links and iCal feed UID generation)

## User-resolved design choices

1. **Multi-user scope** — single-user v1 with multi-user-ready schema. UI hides the picker; defaults assume one household member.
2. **Channels** — Web Push + email (ForwardEmail) + iCal feed. All three.
3. **Reminders vs Reminders + Checklists** — Reminders only. Checklists deferred.
4. **Recurrence flavors** — interval + monthly + yearly. Anchored RRULE deferred.
5. **Per-user notification prefs** — channel toggles + quiet hours (single window/day). Per-day-of-week granularity deferred.

## Schema

### `Reminder` (new)

```prisma
model Reminder {
  id                      String              @id @default(cuid())
  itemId                  String?
  item                    Item?               @relation(fields: [itemId], references: [id], onDelete: SetNull)
  title                   String
  description             String?             @db.Text
  recurrence              Json                // { kind: "interval"|"monthly"|"yearly", ... }
  lastCompletedOn         DateTime?
  nextDueOn               DateTime
  leadTimeDays            Int                 @default(3)
  notifyUserIds           String[]            // multi-user-ready; v1 always [currentUser.id]
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
```

`Reminder.itemId` uses `onDelete: SetNull` (not Cascade): a reminder might still be valid as a generic chore even after the item is deleted (e.g., "Replace HVAC filter" survives a furnace replacement, the user just relinks it).

`Reminder.notifyUserIds` is `String[]` for forward-compat. v1 always inserts the single current user. **Validation invariant** (enforced at the application layer in `lib/reminders/actions.ts`): every id in `notifyUserIds` must reference an existing User. Not a DB-level FK because Prisma can't model an array of FKs natively.

### `ReminderCompletion` (new)

```prisma
model ReminderCompletion {
  id                      String         @id @default(cuid())
  reminderId              String
  reminder                Reminder       @relation(fields: [reminderId], references: [id], onDelete: Cascade)
  completedById           String
  completedBy             User           @relation(fields: [completedById], references: [id])
  completedOn             DateTime
  notes                   String?        @db.Text
  createdServiceRecordId  String?
  createdServiceRecord    ServiceRecord? @relation(fields: [createdServiceRecordId], references: [id], onDelete: SetNull)
  createdAt               DateTime       @default(now())

  @@index([reminderId, completedOn])
}
```

`ServiceRecord.createdFromReminderCompletion` (the inverse) is added on `ServiceRecord` as `Reminder.createdServiceRecord` is `SetNull` — a service record outlives the completion it was generated from.

### `NotificationLog` (new — audit + dedupe)

```prisma
model NotificationLog {
  id          String   @id @default(cuid())
  reminderId  String
  reminder    Reminder @relation(fields: [reminderId], references: [id], onDelete: Cascade)
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel     String   // "push" | "email"  (iCal is pull-based, not logged)
  cycle       String   // "reminder-<id>-<YYYY-MM-DD>"
  sentAt      DateTime @default(now())
  status      String   // "queued" | "sent" | "failed" | "skipped"
  errorReason String?

  @@unique([reminderId, userId, channel, cycle])
  @@index([reminderId])
}
```

The `(reminderId, userId, channel, cycle)` unique constraint is the dedupe primitive. The cron tick handler INSERTs a row with `status='queued'` BEFORE dispatching to the channel adapter. If the INSERT fails on the unique constraint, the worker knows that cycle has already been notified and skips. Hard-crash mid-send leaves the row in `'queued'` — fine for v1; a sweeper job (Plan 5) can age them out.

The `cycle` value is derived from `Reminder.nextDueOn` formatted as `YYYY-MM-DD`. When the user completes a reminder, `nextDueOn` rolls forward, so the next firing has a fresh cycle key.

### `PushSubscription` (new)

```prisma
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

One row per (user, device). The `endpoint` URL is browser-supplied and globally unique. When `web-push` returns HTTP 404 or 410, the worker deletes the row.

### `User` (modified)

```prisma
model User {
  // ...existing columns from Plan 1...
  notificationPrefs   Json?
  icsToken            String?    @unique

  pushSubscriptions   PushSubscription[]
  reminderCompletions ReminderCompletion[]
  notificationLogs    NotificationLog[]
}
```

`notificationPrefs` is validated at the application layer with this Zod shape:

```ts
const notificationPrefsSchema = z.object({
  pushEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(false),
  quietStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
  quietEnd:   z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
  timezone:   z.string().default('UTC'),
});
```

`icsToken` is generated lazily (Settings → Calendar's first visit) via `crypto.randomBytes(24).toString('base64url')`. Regenerating just overwrites the value; the old URL 404s on next request.

### `ServiceRecord` (modified — inverse relation only)

Add `completionFromReminder ReminderCompletion?` (the inverse of `ReminderCompletion.createdServiceRecord`). No data migration; the column on `ReminderCompletion` is the new one.

## Recurrence

```ts
// lib/reminders/recurrence.ts
export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), days: z.number().int().min(1).max(3650) }),
  z.object({ kind: z.literal('monthly'),  dayOfMonth: z.number().int().min(1).max(28) }),
  z.object({ kind: z.literal('yearly'),   month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(28) }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;

export function computeNextDueOn(rec: Recurrence, completedOn: Date): Date;
```

- `interval`: returns `completedOn + days * 86_400_000`.
- `monthly`: returns the next occurrence of `dayOfMonth` strictly after `completedOn`. Implemented via `rrule` (`{ freq: MONTHLY, bymonthday: [n], dtstart: completedOn + 1 day }`, take the first occurrence).
- `yearly`: same idea with `{ freq: YEARLY, bymonth: [m], bymonthday: [d] }`.

The `dayOfMonth` and `day` caps at 28 are intentional — they sidestep the "no Feb 30" / "no Apr 31" edge entirely. UI explains the cap inline.

## Scheduling engine

### Cron tick

`worker/jobs/reminders-tick.ts` registered at worker startup:

```ts
await boss.schedule('reminders.tick', '*/5 * * * *');
await boss.work('reminders.tick', { batchSize: 1 }, async () => {
  await handleRemindersTick();
});
```

`handleRemindersTick` does:

```
1. Load reminders due-or-soon-due:
   prisma.reminder.findMany({
     where: {
       active: true,
       nextDueOn: { lte: <now + maxLeadTimeDays>::date },
     },
   })
   (maxLeadTimeDays is computed as MAX(leadTimeDays) across active reminders, capped at 30)

2. For each reminder, build the cycle string `reminder-<id>-<nextDueOn:YYYY-MM-DD>`.

3. For each (reminder × user-in-notifyUserIds × channel-enabled-in-prefs):
   - Skip if NotificationLog row exists for (reminderId, userId, channel, cycle).
   - Otherwise enqueue a `notify` job with that 4-tuple as payload.

4. Done — the tick handler does not send notifications itself.
```

Per-tick work is bounded: at most ~`activeReminders × users × 2 channels` enqueues, capped by `take` if the active set somehow grows large. For a solo household with dozens of reminders, this is sub-millisecond.

### `notify` job

`worker/jobs/notify.ts`:

```ts
export type NotifyJob = {
  reminderId: string;
  userId: string;
  channel: 'push' | 'email';
  cycle: string;
};
```

Handler:

```
1. Load reminder and user. If reminder is inactive or user no longer exists, return.
2. Compute now() in user's timezone. If quiet-hours active (see lib/notifications/quiet-hours.ts):
   a. Compute next non-quiet timestamp.
   b. boss.send('notify', payload, { startAfter: nextOk }) — re-enqueue.
   c. Return without inserting NotificationLog.
3. Try to INSERT NotificationLog with status='queued'. On unique-constraint violation, return (already sent).
4. Dispatch:
   - 'push':  for each user.pushSubscriptions, call sendPush(); if any return ok, mark log status='sent'.
              if all return reason='subscription-gone', delete each subscription and mark log 'skipped'.
   - 'email': call sendEmail(); update log status='sent' or 'failed' with errorReason.
5. UPDATE NotificationLog with final status + errorReason.
```

### Completion flow

Server action `completeReminder(formData)` in `lib/reminders/actions.ts`:

```
1. auth() — return Unauthorized on miss.
2. Zod-parse: { reminderId, notes?, serviceRecordFields? }.
3. prisma.reminderCompletion.create({ reminderId, completedById, completedOn: now(), notes }).
4. If autoCreateServiceRecord && reminder.itemId:
   - Validate serviceRecordFields with createServiceRecordSchema.
   - prisma.serviceRecord.create({ ...fields, itemId, performedOn: now() }).
   - Update completion row with createdServiceRecordId.
5. nextDueOn = computeNextDueOn(reminder.recurrence, completedOn).
6. prisma.reminder.update({ where: { id }, data: { lastCompletedOn: completedOn, nextDueOn } }).
7. revalidatePath('/reminders'), revalidatePath(`/reminders/${id}`), revalidatePath('/dashboard'),
   and revalidatePath(`/items/${itemId}?tab=reminders`) if itemId set.
```

Old `NotificationLog` rows are not deleted; they're permanent audit. The cycle key naturally rolls over because `nextDueOn` changed.

## Notification delivery adapters

### `lib/notifications/push.ts`

Uses `web-push` configured at module init with `webpush.setVapidDetails(env.WEB_PUSH_CONTACT_EMAIL, env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY)`.

```ts
export async function sendPush(
  sub: { id: string; endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string },
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

On success, updates `PushSubscription.lastUsedAt`. On 404/410, deletes the subscription. Other errors return `{ ok: false, reason }`.

The payload JSON is consumed by `public/sw.js`:

```js
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'House Manager', {
      body: data.body,
      data: { url: data.url },
      icon: '/icon.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

### `lib/notifications/email.ts`

```ts
export async function sendEmail(
  to: string,
  payload: { subject: string; text: string; html: string },
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

Implementation: `fetch('https://api.forwardemail.net/v1/emails', { method: 'POST', headers, body })` with HTTP Basic auth. On non-2xx, return `{ ok: false, reason: ${status} ${statusText}: ${body} }`.

The HTML body is server-rendered via the same `<Markdown>` component used elsewhere (description as markdown), wrapped in a tiny HTML shell with title, "Mark complete" button (link to `<APP_URL>/reminders/<id>?action=complete`), and a footer. Plain-text body is the markdown source plus the URL.

### `lib/notifications/quiet-hours.ts`

```ts
export function isInQuietWindow(now: Date, prefs: NotificationPrefs): boolean;
export function nextNonQuietTime(now: Date, prefs: NotificationPrefs): Date;
```

Pure functions on the prefs JSON. `quietStart`/`quietEnd` are `HH:MM` strings interpreted in `prefs.timezone`. Window crossing midnight (e.g., 22:00–07:00) handled correctly.

If both are null, `isInQuietWindow` returns false; `nextNonQuietTime` returns `now`.

## iCal feed

Route handler at `app/api/calendar/[token]/route.ts`:

```
GET /api/calendar/<token>.ics
```

Notice the `[token]` segment includes the `.ics` suffix as part of the matched value. The handler strips the suffix before lookup. (Alternative: a `[...token]` catch-all with manual parse — same effect.)

Steps:

1. Strip `.ics` suffix from token. Look up `User.icsToken` (unique). 404 if not found.
2. Query active reminders where `notifyUserIds` includes the user. For each, expand recurrence to up-to-12-months-of-future occurrences (using `rrule` for monthly/yearly; arithmetic for interval, projected from `nextDueOn`).
3. Build VCALENDAR with `ical-generator`:
   ```
   For each occurrence:
     UID: reminder-<reminderId>-<occurrenceDateISO>
     DTSTART;VALUE=DATE: <occurrenceDate>
     SUMMARY: <reminder.title>
     DESCRIPTION: <reminder.description plain-text>
     URL: <APP_URL>/reminders/<reminderId>
     VALARM:
       TRIGGER: -P<leadTimeDays>D
       ACTION: DISPLAY
       DESCRIPTION: <reminder.title> due
   ```
4. Return `text/calendar; charset=utf-8`.

Token regeneration is a server action `regenerateIcsToken(): Promise<{ token: string }>` that overwrites `User.icsToken` with a fresh `crypto.randomBytes(24).toString('base64url')`. UI in Settings → Calendar shows the URL (with the new token), copy button, regenerate button.

## UI

### Routes

- `/reminders` — list
- `/reminders/new` — create form
- `/reminders/[id]` — detail with completion history + upcoming preview
- `/reminders/[id]/edit` — edit form

### Per-entity surfaces

- **Item detail page** (`app/(app)/items/[id]/page.tsx`) — adds a sixth tab `Reminders`. Lists reminders with `itemId = item.id`. "+ Add reminder" prefills `?itemId=`.
- **Dashboard** — adds an "Upcoming reminders" section between Quick stats and Quick actions: top 5 reminders by `nextDueOn` ascending. Each row: title · "Due in X days" / "Overdue by X days" · "Mark complete" inline form button.

### Components

- `components/reminders/RecurrencePicker.tsx` (Client) — three radio options (interval / monthly / yearly), each with the inputs that flavor needs. Output: a `Recurrence` JSON serialized into a hidden form field. Reused by create + edit pages.
- `components/reminders/ReminderForm.tsx` (Client) — RHF + Zod, mirrors the established `ItemForm`/`VendorForm` pattern. Mounts `RecurrencePicker` + ItemAutocomplete (reused) + plain inputs for title/description/leadTime/auto-create-service-record. After save, redirects to `/reminders/<id>`.
- `components/reminders/ReminderTable.tsx` (Server) — list rendering with status badges (Active / Inactive / Overdue / Due Soon).
- `components/reminders/ReminderStatusBadge.tsx` (Server) — same shape as Plan 2a's `WarrantyStatusBadge`. Computes from `nextDueOn`: overdue (red `--danger`), due-soon (`--warning`), upcoming (`--fg-muted`), inactive (greyed).
- `components/reminders/CompleteReminderForm.tsx` (Client) — opens an inline form for notes + (if autoCreateServiceRecord) ServiceRecord fields. Submit calls `completeReminder` action.
- `components/reminders/PushSubscribeButton.tsx` (Client) — orchestrates `Notification.requestPermission()` → `pushManager.subscribe()` → server action to record the subscription. Surfaces permission-denied state inline.

### Settings → Notifications

A new section on `/settings`:

```
Browser push
  [Subscribe / Unsubscribe button per device]
  Subscribed devices (N):
    • <userAgent> — added <date>   [Remove]

Email
  [✓] Send reminders to: <user.email>  (read-only, from OIDC profile)

Quiet hours
  [✓] Don't send between [HH:MM] and [HH:MM]
  Timezone: [IANA dropdown ▼]
```

The form posts to `saveNotificationPrefs` server action; same find-or-create-on-User-row pattern as Plan 2a's HouseProfile editor.

### Settings → Calendar

```
Subscribe with your calendar app:

  <APP_URL>/api/calendar/<token>.ics
  [Copy]   [Regenerate URL]

Paste this URL into Apple Calendar, Google Calendar, etc. The calendar
will check for updates every few hours.
```

First visit (no `icsToken` yet) shows: a single "Generate calendar URL" button that calls `regenerateIcsToken` and re-renders.

### Activity feed

Dashboard `recentActivity` adds a sixth event type `reminder-completed`:
- Label: `Completed: <reminder.title>`
- Icon: `✅`
- Href: `/reminders/<id>`

## Security

- **VAPID private key** stored in `WEB_PUSH_VAPID_PRIVATE_KEY` env var; never exposed to client. Public key served via `/api/push/vapid-key` route handler returning JSON.
- **Push payloads** are encrypted by `web-push` per the Push API spec; sniffing the channel reveals nothing.
- **iCal token** is `crypto.randomBytes(24).toString('base64url')` — 192 bits of entropy. Brute-forcing is not feasible. Token revocation is one column update.
- **iCal route** authenticates only via the token. No `auth()` session check — calendar apps don't carry cookies. Compromise of the token leaks the user's reminder titles and dates only (not body text or attachments). User can regenerate from Settings.
- **Email "Mark complete" link** carries the bare reminder id (`?action=complete`). The `/reminders/<id>` page requires auth; clicking from a logged-out browser triggers OIDC sign-in first. No "magic link" auth.
- **ForwardEmail API key** stored in `FORWARDEMAIL_API_KEY`, never client-side.
- **CSRF**: server actions and the iCal route are same-origin or token-authenticated; no cross-origin write paths.

## Testing

### Unit (≈25 cases)

- `lib/reminders/recurrence.test.ts` — `computeNextDueOn` for interval/monthly/yearly with edge cases (completion exactly on due day, completion past due day).
- `lib/reminders/schema.test.ts` — Zod schemas: bounds on `interval.days` (reject 0, 3651), `monthly.dayOfMonth` (reject 0, 29), `yearly.month/day` bounds, unknown `kind` rejected.
- `lib/notifications/quiet-hours.test.ts` — `isInQuietWindow` and `nextNonQuietTime` with daytime window, overnight window (22:00–07:00), null bounds, timezone variants.

### Integration (≈15 cases)

- `tests/integration/reminders.test.ts` — CRUD round-trip, `completeReminder` updates `nextDueOn` correctly, `Item` deletion sets `Reminder.itemId` to null (SetNull), `User` deletion cascade-deletes `PushSubscription` and `ReminderCompletion`.
- `tests/integration/notification-log.test.ts` — unique constraint rejects duplicate `(reminderId, userId, channel, cycle)`; cycle key changes after `completeReminder` (because `nextDueOn` changes).
- `tests/integration/notify-job.test.ts` — invokes `handleNotify` with a mocked channel adapter; verifies log row inserted with right shape; verifies quiet-hours re-queue path inserts no log and calls `boss.send` with `startAfter`.

### Worker / cron tick (≈5 cases)

- `worker/jobs/reminders-tick.test.ts` — handler enqueues per (user × channel) for due reminders, dedupes via NotificationLog query, skips inactive reminders, respects empty `notifyUserIds`.

### iCal feed (≈6 cases)

- `tests/integration/ical.test.ts` — valid token returns 200 + `text/calendar`, invalid token 404, recurring reminder expands to multiple VEVENTs, VALARM TRIGGER reflects `leadTimeDays`, inactive reminder absent.

### E2E (1 spec)

- `tests/e2e/reminders.spec.ts` — sign in → create item → Reminders tab → create reminder ("Replace filter every 60 days") → assert "Due in 60 days" copy → click "Mark complete" → assert next due rolls to ~120 days → completion appears in History → Settings → Calendar shows generated URL with copy button.

Push delivery is **not E2E-tested** (Playwright doesn't have stable APIs for browser-push permission prompts). Manual smoke covered in the implementation plan.

### Manual smoke checklist (in plan)

- Create reminder due in 1 minute, wait for tick → push notification arrives on enabled devices.
- Click "Mark complete" link in a push notification → land on reminder detail with completion form.
- Subscribe to iCal URL in Apple Calendar → events appear; toggle quiet hours → next firing is delayed.
- Toggle email enabled, add a recipient → next firing produces an email via ForwardEmail.

### What's NOT tested

- Real ForwardEmail delivery (requires API key + verified domain). Integration test mocks fetch and asserts on the request payload.
- Real Web Push delivery (manual smoke only).
- Calendar app rendering (manual smoke).

## Open questions

1. **Email-from address verification** — ForwardEmail requires the From domain be verified before it'll send. We'll need to call out env-var setup + DNS setup in the implementation plan, but this is a one-time operator step rather than ongoing concern.
2. **Notification icon** — `/icon.png` referenced in the service worker doesn't exist yet. The implementation plan should add a placeholder icon (192x192 PNG) under `public/`.
3. **Reminder reschedule on `recurrence` edit** — if the user edits `recurrence` from "every 60 days" to "every 30 days", do we recompute `nextDueOn` immediately? v1 leaves `nextDueOn` alone (the user can manually adjust if they want); the next completion will use the new recurrence. Documented in the plan as a known limitation.

## Risks

- **Cron job missing** — if the worker process is down, no reminders fire. Plan 5 polish could add a "missed-tick recovery" mode (on worker startup, look back N hours and catch up). For v1, the existing pg-boss job recovery (jobs persist in DB) handles brief worker outages naturally.
- **Push permission UX** — first-time users need to click "Subscribe" → grant browser permission. If they deny, recovery requires diving into browser site settings. We surface clear inline copy ("To re-enable, allow in your browser's site settings").
- **Quiet-hours interaction with leadTimeDays** — an overnight reminder due tomorrow with `leadTimeDays = 0` and quiet hours 22:00–07:00 fires at 07:00 of the due date, which means notification arrives the same morning it's due. Acceptable for v1; users wanting earlier alerts should set `leadTimeDays >= 1`.
- **iCal feed staleness** — calendar apps poll every few hours. A reminder created 5 minutes ago won't show in the user's calendar for hours. We don't try to push iCal updates; users wanting near-real-time get push instead.
- **`web-push` native binding maintenance** — `web-push` is pure JS in v3+, no native deps. Renovate handles ongoing bumps.
- **ForwardEmail API rate limits / outages** — failure surfaces as a `failed` NotificationLog row with the error reason; no retry beyond pg-boss's default. A real outage would be observable via the log; v1 doesn't add operator alerting.
