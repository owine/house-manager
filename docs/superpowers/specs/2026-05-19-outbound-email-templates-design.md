# Outbound Email Template Layer — Design

**Date:** 2026-05-19
**Status:** Design — pending review

## Problem

Outbound email transport (`lib/notifications/email.ts`, ForwardEmail v1) is production-ready, but email *content* is a bare stub. There is exactly one outbound email — the reminder notification at `worker/jobs/notify.ts:100-102` — composed from three inline string literals:

```js
subject = `Reminder: ${reminder.title}`
text    = `${reminder.description ?? ''}\n\n${url}`
html    = `<p>${escapeHtml(reminder.description ?? '')}</p><p><a href="${url}">Mark complete</a></p>`
```

Defects:

- No template/layout module exists anywhere.
- Empty-description ⇒ empty body: `reminder.description` is optional; when null the body is `<p></p><p><a>Mark complete</a></p>` and the **title never appears in the body** (subject only). This is a correctness bug, not just polish.
- Mislabeled CTA: link text is "Mark complete" but `href` is `/reminders/{id}` — it only opens the page.
- No reminder context (due date, linked item/system) despite the data model carrying it; the `findUnique` selects only `id, title, description, active`.
- Broken links when `APP_URL` is unset: `${env.APP_URL ?? ''}/reminders/{id}`.
- Zero content test coverage: `notify-job.test.ts` asserts nothing about `subject`/`html`/`text`.

## Goals

- A reusable, pure email-composition layer designed for future email types.
- Only the reminder email is wired now (no speculative new email types).
- Fix the empty-body bug, mislabeled CTA, missing context, and broken-link cases.
- owine-branded layout.
- Close the content/safety test gap.

## Non-goals

- No new outbound email types (digest, overdue summary, etc.) in this work.
- No one-click-complete / tokenized email actions (no new auth surface).
- No change to the transport module `lib/notifications/email.ts`.
- No new runtime dependencies.

## Architecture

Three units with distinct responsibilities:

| Unit | Responsibility | Depends on |
|---|---|---|
| `lib/notifications/email.ts` (existing, unchanged) | **Transport** — POST to ForwardEmail | `fetch`, env |
| `lib/email/` (new) | **Composition** — pure: resolved data → `{ subject, html, text }` | React, `react-dom/server` only |
| `worker/jobs/notify.ts` (modified) | **Orchestration** — data query, `APP_URL` guard, compose then send | Prisma, the two units above |

```
lib/email/
  layout.tsx       owine-branded shared React shell (header, container, footer)
  render.ts        renderEmail(node) → { html, text }
  templates/
    reminder.tsx   reminderEmail(data) → { subject, html, text }  — pure
```

- `lib/email/` performs **no I/O**: no Prisma, no `fetch`, no env reads. It receives already-resolved data and returns strings. Fully unit-testable without a worker, DB, or network.
- HTML is produced via `react-dom/server` `renderToStaticMarkup` — zero new deps, mirrors the existing `lib/incoming-email/render-html.tsx` pattern.
- Plain-text is **first-class**: each template constructs its `text` from the same resolved data, not by stripping HTML.

### Composition interface

```ts
// lib/email/render.ts
export function renderEmail(node: ReactElement): { html: string };

// lib/email/templates/reminder.tsx
export type ReminderEmailData = {
  reminderId: string;
  title: string;
  description: string | null;
  appUrl: string;                 // guaranteed non-empty by the caller
  timezone: string;               // from notification prefs
  targets: Array<{
    nextDueOn: Date;
    item?: { id: string; name: string };
    system?: { id: string; name: string };
  }>;
};
export function reminderEmail(data: ReminderEmailData): {
  subject: string;
  html: string;
  text: string;
};
```

The template owns both `html` (via `renderEmail` over its React tree) and `text` (built directly from `data`).

## Data flow (`notify.ts` email branch)

1. Expand the email-branch `reminder.findUnique` `select` to include `title`, `description`, and `targets { nextDueOn, item { id, name }, system { id, name } }`.
2. **`APP_URL` guard:** if `env.APP_URL` is unset/empty, do not send. Mark the `NotificationLog` `skipped` with `errorReason: 'APP_URL not configured'` and `console.warn`. This reuses the existing skip-with-reason pattern (`'no email'`, `'no subscriptions'`) — no new machinery, observable in the existing log table. Rejected alternative: conditionally requiring `APP_URL` in env validation (broader blast radius).
3. Build `ReminderEmailData` from the enriched row + `prefs.timezone` + `env.APP_URL`.
4. `const { subject, html, text } = reminderEmail(data)`.
5. `await sendEmail(user.email, { subject, text, html })` (unchanged transport).
6. Update `NotificationLog` `sent`/`failed` exactly as today.

## Reminder email content

| Element | Source |
|---|---|
| Subject | `Reminder: {title}` |
| Title (h1 in body — fixes empty-body bug) | `data.title` |
| Due date(s) | per-target `nextDueOn`, formatted in `data.timezone` |
| Linked items/systems | each target → name + absolute link to `{appUrl}/items/{id}` or `{appUrl}/systems/{id}` |
| Description | included only when present; absence never yields an empty body |
| CTA | "View reminder" → `{appUrl}/reminders/{reminderId}` |
| Footer | "Manage notification settings" → `{appUrl}/settings` |

**Multi-target:** a reminder may target several items/systems, each with its own `nextDueOn`. The email lists each target with its own due date rather than collapsing — the template stays a faithful 1:1 render of resolved data with no aggregation logic.

## Branding (`layout.tsx`)

- Single shared layout wrapping every email.
- Email clients strip `<style>` blocks and ignore CSS variables/classes — therefore **every style is an inline `style={{}}`**; no Tailwind, no class names, no `<style>`.
- Structure: centered fixed-max-width (~600px) container on a neutral page background; header band with the app name in owine brand color; white content card; muted footer with the settings link.
- System font stack (web fonts unreliable in email).
- owine hex values + type scale are sourced from the `owine-design` skill at implementation time and frozen as documented constants in `layout.tsx`. This duplicates the app's design tokens deliberately: email and app rendering have irreconcilable CSS capabilities, so a shared token source would leak email constraints into the app. ~10 constants, commented with rationale.

## Testing

- **Unit — `lib/email/templates/reminder.test.ts`:**
  - title appears in the **body** even when `description` is `null` (load-bearing — the empty-body bug)
  - subject is `Reminder: {title}`
  - due date rendered in the supplied timezone
  - each target produces a correctly-href'd absolute link (`/items/{id}`, `/systems/{id}`)
  - CTA href = `{appUrl}/reminders/{reminderId}`, label is "View reminder" (not "Mark complete")
  - both `html` and `text` returned, non-empty; `text` is structured (not HTML-stripped)
- **Unit — `lib/email/render.test.ts`:** rendered markup is inline-styled with no `<style>` tag and no `className`/`class` attributes (guards the email-client-safety contract).
- **Integration — extend `tests/integration/notify-job.test.ts`:** assert the composed payload reaching `sendEmail` (subject + key links); assert the `APP_URL`-unset path marks the log `skipped` with reason `'APP_URL not configured'`.

## Risks & mitigations

- **owine token drift:** duplicated hex in `layout.tsx` can diverge from the app. Mitigation: a single commented constants block citing the `owine-design` source; acceptable given the hard CSS boundary.
- **Email-client rendering variance:** mitigated by inline styles, table/div container, system fonts, and the no-`<style>`/no-class render test.
- **Timezone formatting:** uses the same `prefs.timezone` already read in `notify.ts`; no new tz source introduced.

## Out of scope / future

- Additional email types reuse `lib/email/layout.tsx` + `render.ts` and add a sibling under `templates/`.
- One-click signed actions, if ever wanted, are a separate auth-surface design.
