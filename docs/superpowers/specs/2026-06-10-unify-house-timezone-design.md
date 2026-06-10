# Unify timezone on a single house-wide setting

**Date:** 2026-06-10
**Status:** Approved (design)

## Problem

The app reads timezone from two independent places that can disagree:

- **`HouseProfile.timezone`** — drives the in-app overdue badge, the `.ics` calendar
  feed, and the chore auto-complete worker. Defaults to `"UTC"` and is **not
  settable** in the UI (`saveHouseProfile` never persists the field).
- **`NotificationPrefs.timezone`** (per-user JSON) — drives digest emails, digest
  scheduling, and quiet hours. It *is* settable (the Timezone select in
  `NotificationPrefsForm`).

A solo self-hoster who sets their notification timezone to `America/Chicago` gets
overdue **emails** computed in Chicago while the in-app **badge** stays on UTC — the
two surfaces disagree about whether the same reminder is overdue. (The off-by-one
overdue bug itself was fixed separately in PR #225; this work removes the
divergence that let email and UI reach different conclusions.)

## Goal

One canonical timezone — `HouseProfile.timezone`, editable in Settings — governs
**everything**: overdue/due/badge/.ics/auto-complete, digest content, digest
scheduling, and quiet hours. Remove the per-user `NotificationPrefs.timezone`.

This is correct for a single-user / single-house deployment: "what calendar day is
it at the house" is inherently one value, and notification scheduling follows it.

## Design

### 1. `HouseProfile.timezone` becomes the single source of truth, settable in Settings

- Add `timezone` (IANA string, default `'UTC'`) to `houseProfileSchema` and persist
  it in `saveHouseProfile`.
- Add a Timezone `<Select>` to `HouseProfileForm`. Reuse the existing option list by
  lifting `TIMEZONE_OPTIONS` (currently private to `NotificationPrefsForm`) into a
  shared module, e.g. `lib/time/timezones.ts`.
- Add `getHouseTimezone()` (returns `timezone ?? 'UTC'`) for use by server
  components and the worker, DRYing the `houseProfile.findFirst({ select: { timezone } })`
  pattern already in `chore-auto-complete-tick`.

### 2. Repoint the notification pipeline at the house timezone

- `lib/notifications/quiet-hours.ts`: `isInQuietWindow` and `nextNonQuietTime` take an
  explicit `tz` argument instead of reading `prefs.timezone`.
- `worker/jobs/notify.ts`: fetch the house tz once per tick; pass it to quiet-hours
  and the reminder email template (replacing `prefs.timezone`).
- `worker/jobs/digest-tick.ts`: use the house tz for `localParts` (scheduling),
  `getOverdueForUser`/`getWeeklyForUser`, and the digest email template.

### 3. Remove the per-user `NotificationPrefs.timezone`

- Drop the `timezone` field from `notificationPrefsSchema` and
  `defaultNotificationPrefs`. Existing stored JSON keeps working — Zod strips the
  now-unknown key on read.
- Remove the Timezone control from `NotificationPrefsForm`.

## Components / boundaries

- `lib/time/timezones.ts` — shared `TIMEZONE_OPTIONS` (the only "what zones do we
  offer" list).
- `lib/house-profile/` — schema + action persist `timezone`; `getHouseTimezone()`
  is the single read path.
- `quiet-hours` — pure functions parameterized by `tz`; no implicit prefs coupling.
- Workers (`notify`, `digest-tick`) — own the "fetch house tz, thread it through"
  responsibility; queries/templates stay tz-agnostic (receive a string).

## Behavior change to note

Digest **scheduling** (deliver overdue digest at hour H; weekly on day D) now
evaluates in the **house** timezone rather than a per-user one. For a single-user
deployment this is the intended behavior.

## Testing

- `lib/house-profile`: `saveHouseProfile` persists `timezone`; `getHouseTimezone`
  fallback to `'UTC'`.
- `quiet-hours`: existing tests updated to pass `tz` explicitly.
- `digest-tick` / `notify`: assert the house tz (not a prefs value) drives
  scheduling, overdue selection, and quiet-hour deferral.
- `prefs`: `timezone` no longer present; unknown stored key is ignored.
- `NotificationPrefsForm`: Timezone control removed; `HouseProfileForm`: control
  present and submits.

## Out of scope

- Multi-user-with-distinct-zones support (per-user delivery zones). Revisit only if
  multiple users in different timezones is ever a real requirement.
- Any change to date-only storage (already UTC midnight) or the `.ics` feed shape.
