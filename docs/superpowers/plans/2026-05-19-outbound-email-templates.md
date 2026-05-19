# Outbound Email Template Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline-string reminder email body in `worker/jobs/notify.ts` with a reusable, pure `lib/email/` composition layer; fix the empty-body / missing-context / mislabeled-CTA / broken-link defects; close the content + render-safety test gap.

**Architecture:** New pure module `lib/email/` (layout + render wrapper + reminder template). Returns `{ subject, html, text }` from already-resolved data — no Prisma, no `fetch`, no env. The worker (`notify.ts`) enriches its Prisma query, guards on `APP_URL`, composes, then hands the result to the existing untouched `lib/notifications/email.ts` transport. HTML via `react-dom/server` `renderToStaticMarkup` (zero new deps, mirrors `lib/incoming-email/render-html.tsx`).

**Tech Stack:** TypeScript, React (server render only — `react-dom/server`), Vitest 4 (unit + integration via Testcontainers), Prisma 7. owine brand tokens frozen as constants in `lib/email/layout.tsx` (sourced from the `owine-design` skill — duplicated deliberately because email CSS can't share the app's CSS-variable token source).

**Spec:** `docs/superpowers/specs/2026-05-19-outbound-email-templates-design.md`

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `lib/email/layout.tsx` | **create** | owine-branded shared React shell (header, content card, footer). Exports frozen brand-token constants. |
| `lib/email/render.ts` | **create** | `renderEmail(node) → { html }` — thin wrapper over `renderToStaticMarkup`, prepends doctype, asserts the email-client-safety contract via tests. HTML-only by design. |
| `lib/email/templates/reminder.tsx` | **create** | `reminderEmail(data) → { subject, html, text }` — pure. Builds the React tree (via Layout) AND constructs `text` from the same `data`. |
| `lib/email/render.test.ts` | **create** | Asserts no `<style>` tag and no `class`/`className` attributes survive rendering. |
| `lib/email/templates/reminder.test.ts` | **create** | All the load-bearing content assertions from the spec (title-in-body when description is null, due dates, target links, CTA href/label, footer, structured text). |
| `worker/jobs/notify.ts` | **modify** | Enrich the email-branch `select`, add `APP_URL` skip guard, build `ReminderEmailData`, call `reminderEmail()`, send via existing transport. |
| `tests/integration/notify-job.test.ts` | **modify** | Add content assertions on the composed payload + the `APP_URL`-unset skip-path assertion. |
| `lib/notifications/email.ts` | unchanged | Transport stays as-is. |

---

## Task 1: Scaffold `lib/email/layout.tsx` with owine brand constants

**Files:**
- Create: `lib/email/layout.tsx`

Pure React component. No tests in this task — `render.test.ts` (Task 2) and `reminder.test.ts` (Task 3) exercise it.

- [ ] **Step 1: Create `lib/email/layout.tsx`**

```tsx
/**
 * Shared layout for outbound email. Email clients strip <style> tags and
 * ignore CSS variables / classes — therefore every style here is inline.
 *
 * owine brand tokens are duplicated below as frozen constants. Email and
 * app rendering have irreconcilable CSS capabilities, so the app's
 * CSS-variable token source can't be reused. Keep these in sync manually
 * with the `owine-design` skill if the brand evolves.
 */
import type { ReactNode } from 'react';

// --- owine brand tokens (frozen for email) ---
export const EMAIL_TOKENS = {
  paper: '#f6f4ef',
  card: '#fbfaf6',
  line: '#dcd6cc',
  ink: '#0e1620',
  inkMuted: '#5b6878',
  accent: '#2b5fd9',
  // System font stack — web fonts (Geist) are unreliable in email clients.
  fontStack:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
} as const;

const T = EMAIL_TOKENS;

export type LayoutProps = {
  preheader?: string; // hidden preview text shown by some clients
  appUrl: string; // absolute URL base; settings link goes to `${appUrl}/settings`
  children: ReactNode;
};

export function Layout({ preheader, appUrl, children }: LayoutProps): ReactNode {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>House Manager</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: T.paper,
          color: T.ink,
          fontFamily: T.fontStack,
          fontSize: '16px',
          lineHeight: 1.5,
        }}
      >
        {preheader ? (
          <div
            style={{
              display: 'none',
              maxHeight: 0,
              overflow: 'hidden',
              color: T.paper,
            }}
          >
            {preheader}
          </div>
        ) : null}
        <div
          style={{
            maxWidth: '600px',
            margin: '0 auto',
            padding: '24px 16px',
          }}
        >
          <div
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: T.ink,
              padding: '0 0 16px 0',
            }}
          >
            House Manager
          </div>
          <div
            style={{
              backgroundColor: T.card,
              border: `1px solid ${T.line}`,
              borderRadius: '8px',
              padding: '24px',
            }}
          >
            {children}
          </div>
          <div
            style={{
              fontSize: '12px',
              color: T.inkMuted,
              padding: '16px 0 0 0',
            }}
          >
            <a
              href={`${appUrl}/settings`}
              style={{ color: T.inkMuted, textDecoration: 'underline' }}
            >
              Manage notification settings
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add lib/email/layout.tsx
git commit -m "feat(email): add owine-branded Layout component for outbound mail"
```

---

## Task 2: `renderEmail` wrapper + render-safety test (TDD)

**Files:**
- Create: `lib/email/render.test.ts`
- Create: `lib/email/render.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/email/render.test.ts
import { describe, expect, it } from 'vitest';
import { Layout } from './layout';
import { renderEmail } from './render';

describe('renderEmail', () => {
  it('returns an html string starting with a doctype', () => {
    const { html } = renderEmail(
      <Layout appUrl="https://example.test">
        <p>hello</p>
      </Layout>,
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<p>hello</p>');
  });

  it('produces no <style> tags (email-client safety contract)', () => {
    const { html } = renderEmail(
      <Layout appUrl="https://example.test">
        <p>hello</p>
      </Layout>,
    );
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('produces no class/className attributes (email-client safety contract)', () => {
    const { html } = renderEmail(
      <Layout appUrl="https://example.test">
        <p>hello</p>
      </Layout>,
    );
    expect(html).not.toMatch(/\bclass\s*=/i);
    expect(html).not.toMatch(/\bclassName\s*=/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/email/render.test.ts`
Expected: FAIL — `Cannot find module './render'`.

- [ ] **Step 3: Implement `renderEmail`**

```ts
// lib/email/render.ts
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * HTML-only by design. Plain text is NOT threaded through here — each
 * template builds its own `text` from resolved data (see templates/reminder.tsx).
 */
export function renderEmail(node: ReactElement): { html: string } {
  const body = renderToStaticMarkup(node);
  return { html: `<!doctype html>${body}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/email/render.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add lib/email/render.ts lib/email/render.test.ts
git commit -m "feat(email): add renderEmail wrapper + email-client safety tests"
```

---

## Task 3: `reminderEmail` template (TDD)

**Files:**
- Create: `lib/email/templates/reminder.test.ts`
- Create: `lib/email/templates/reminder.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/email/templates/reminder.test.ts
import { describe, expect, it } from 'vitest';
import { reminderEmail, type ReminderEmailData } from './reminder';

function baseData(overrides: Partial<ReminderEmailData> = {}): ReminderEmailData {
  return {
    reminderId: 'rem_1',
    title: 'Replace furnace filter',
    description: null,
    appUrl: 'https://hm.example',
    timezone: 'America/New_York',
    targets: [
      {
        nextDueOn: new Date('2026-06-01T12:00:00Z'),
        item: { id: 'itm_1', name: 'Furnace' },
      },
    ],
    ...overrides,
  };
}

describe('reminderEmail', () => {
  it('builds the subject from the reminder title', () => {
    const { subject } = reminderEmail(baseData());
    expect(subject).toBe('Reminder: Replace furnace filter');
  });

  it('includes the title in the body even when description is null', () => {
    // Load-bearing: fixes the empty-body bug where today's email
    // produces <p></p><p><a>...</a></p> with no title in the body.
    const { html, text } = reminderEmail(baseData({ description: null }));
    expect(html).toContain('Replace furnace filter');
    expect(text).toContain('Replace furnace filter');
  });

  it('includes the description when present', () => {
    const { html, text } = reminderEmail(
      baseData({ description: 'Use a MERV-13 filter.' }),
    );
    expect(html).toContain('Use a MERV-13 filter.');
    expect(text).toContain('Use a MERV-13 filter.');
  });

  it('formats due dates in the supplied timezone', () => {
    const { html, text } = reminderEmail(
      baseData({
        timezone: 'America/New_York',
        targets: [
          {
            nextDueOn: new Date('2026-06-01T12:00:00Z'),
            item: { id: 'itm_1', name: 'Furnace' },
          },
        ],
      }),
    );
    // 12:00 UTC on 2026-06-01 is 08:00 in America/New_York — the date
    // portion (June 1) must render in the user's tz, never UTC.
    expect(html).toMatch(/June 1, 2026|Jun 1, 2026/);
    expect(text).toMatch(/June 1, 2026|Jun 1, 2026/);
  });

  it('renders a link for each item target', () => {
    const { html, text } = reminderEmail(
      baseData({
        targets: [
          {
            nextDueOn: new Date('2026-06-01T00:00:00Z'),
            item: { id: 'itm_1', name: 'Furnace' },
          },
        ],
      }),
    );
    expect(html).toContain('href="https://hm.example/items/itm_1"');
    expect(html).toContain('Furnace');
    expect(text).toContain('https://hm.example/items/itm_1');
    expect(text).toContain('Furnace');
  });

  it('renders a link for each system target', () => {
    const { html, text } = reminderEmail(
      baseData({
        targets: [
          {
            nextDueOn: new Date('2026-06-01T00:00:00Z'),
            system: { id: 'sys_1', name: 'Heating' },
          },
        ],
      }),
    );
    expect(html).toContain('href="https://hm.example/systems/sys_1"');
    expect(html).toContain('Heating');
    expect(text).toContain('https://hm.example/systems/sys_1');
  });

  it('renders multiple targets each with its own due date', () => {
    const { html } = reminderEmail(
      baseData({
        targets: [
          {
            nextDueOn: new Date('2026-06-01T00:00:00Z'),
            item: { id: 'itm_1', name: 'Furnace' },
          },
          {
            nextDueOn: new Date('2026-07-15T00:00:00Z'),
            system: { id: 'sys_1', name: 'Heating' },
          },
        ],
      }),
    );
    expect(html).toContain('Furnace');
    expect(html).toContain('Heating');
    expect(html).toMatch(/June 1, 2026|Jun 1, 2026/);
    expect(html).toMatch(/July 15, 2026|Jul 15, 2026/);
  });

  it('renders the CTA labeled "View reminder" with the correct href', () => {
    const { html } = reminderEmail(baseData());
    expect(html).toMatch(
      /<a[^>]*href="https:\/\/hm\.example\/reminders\/rem_1"[^>]*>[^<]*View reminder/,
    );
    expect(html).not.toContain('Mark complete');
  });

  it('includes the settings footer link', () => {
    const { html } = reminderEmail(baseData());
    expect(html).toContain('href="https://hm.example/settings"');
    expect(html).toContain('Manage notification settings');
  });

  it('returns a non-empty structured text (not html-stripped)', () => {
    const { text } = reminderEmail(baseData());
    expect(text.length).toBeGreaterThan(0);
    // Structured text must NOT contain html tags — proves it was built
    // from data rather than stripped from html.
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('escapes html in title/description to prevent injection', () => {
    const { html } = reminderEmail(
      baseData({
        title: '<script>alert(1)</script>Foo',
        description: '<img src=x onerror=evil>',
      }),
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('onerror=evil');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/email/templates/reminder.test.ts`
Expected: FAIL — `Cannot find module './reminder'`.

- [ ] **Step 3: Implement `reminderEmail`**

```tsx
// lib/email/templates/reminder.tsx
import type { ReactNode } from 'react';
import { EMAIL_TOKENS, Layout } from '../layout';
import { renderEmail } from '../render';

const T = EMAIL_TOKENS;

export type ReminderEmailTarget = {
  nextDueOn: Date;
  item?: { id: string; name: string };
  system?: { id: string; name: string };
};

export type ReminderEmailData = {
  reminderId: string;
  title: string;
  description: string | null;
  appUrl: string; // guaranteed non-empty by the caller (see notify.ts guard)
  timezone: string;
  targets: ReminderEmailTarget[];
};

export type ReminderEmailResult = {
  subject: string;
  html: string;
  text: string;
};

/**
 * Format a due date in the user's notification-prefs timezone. The date
 * portion must render in the user's tz, never UTC — a reminder due
 * "today" should read as today in the recipient's local time.
 */
function formatDue(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

type ResolvedTarget = {
  label: string; // item or system name
  href: string; // absolute, appUrl-rooted
  due: string; // formatted in user's tz
};

function resolveTargets(
  data: ReminderEmailData,
): ResolvedTarget[] {
  return data.targets.map((t) => {
    // Schema enforces XOR via parent-XOR check constraint: exactly one of
    // item/system is present per target. If both are missing (shouldn't
    // happen) we fall back to a non-link label so the email still sends.
    if (t.item) {
      return {
        label: t.item.name,
        href: `${data.appUrl}/items/${t.item.id}`,
        due: formatDue(t.nextDueOn, data.timezone),
      };
    }
    if (t.system) {
      return {
        label: t.system.name,
        href: `${data.appUrl}/systems/${t.system.id}`,
        due: formatDue(t.nextDueOn, data.timezone),
      };
    }
    return {
      label: '(no target)',
      href: data.appUrl,
      due: formatDue(t.nextDueOn, data.timezone),
    };
  });
}

function Body({ data }: { data: ReminderEmailData }): ReactNode {
  const targets = resolveTargets(data);
  const ctaHref = `${data.appUrl}/reminders/${data.reminderId}`;
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
        {data.title}
      </h1>
      {targets.length > 0 ? (
        <ul style={{ margin: '0 0 16px 0', paddingLeft: '20px' }}>
          {targets.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable per-render
            <li key={i} style={{ margin: '0 0 4px 0' }}>
              <a href={t.href} style={{ color: T.accent }}>
                {t.label}
              </a>
              <span style={{ color: T.inkMuted }}> — due {t.due}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.description ? (
        <p style={{ margin: '0 0 16px 0', color: T.ink }}>
          {data.description}
        </p>
      ) : null}
      <p style={{ margin: '16px 0 0 0' }}>
        <a
          href={ctaHref}
          style={{
            display: 'inline-block',
            padding: '10px 16px',
            backgroundColor: T.accent,
            color: '#ffffff',
            textDecoration: 'none',
            borderRadius: '6px',
            fontWeight: 500,
          }}
        >
          View reminder
        </a>
      </p>
    </>
  );
}

function buildText(data: ReminderEmailData): string {
  const targets = resolveTargets(data);
  const lines: string[] = [];
  lines.push(data.title);
  lines.push('');
  for (const t of targets) {
    lines.push(`- ${t.label} — due ${t.due}`);
    lines.push(`  ${t.href}`);
  }
  if (targets.length > 0) lines.push('');
  if (data.description) {
    lines.push(data.description);
    lines.push('');
  }
  lines.push(`View reminder: ${data.appUrl}/reminders/${data.reminderId}`);
  lines.push('');
  lines.push(`Manage notification settings: ${data.appUrl}/settings`);
  return lines.join('\n');
}

export function reminderEmail(data: ReminderEmailData): ReminderEmailResult {
  const subject = `Reminder: ${data.title}`;
  const { html } = renderEmail(
    <Layout preheader={`Reminder: ${data.title}`} appUrl={data.appUrl}>
      <Body data={data} />
    </Layout>,
  );
  const text = buildText(data);
  return { subject, html, text };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/email/templates/reminder.test.ts`
Expected: PASS (11/11). If a date-formatting test fails on locale variance, narrow the regex to the exact `Intl.DateTimeFormat('en-US', { month: 'long' })` output (`June 1, 2026`).

- [ ] **Step 5: Run full unit suite to confirm no regression**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/email/templates/reminder.tsx lib/email/templates/reminder.test.ts
git commit -m "feat(email): add reminderEmail template with content + safety tests"
```

---

## Task 4: Wire `reminderEmail` into `worker/jobs/notify.ts`

**Files:**
- Modify: `worker/jobs/notify.ts`

This is the orchestration change. No new unit test in this task — Task 5 extends the existing integration test to cover content + the new skip path.

- [ ] **Step 1: Read current `notify.ts`**

Read `/Users/owine/Git/house-manager/worker/jobs/notify.ts` so you have the existing structure in context.

- [ ] **Step 2: Expand the email-branch `findUnique` `select`**

Currently the function fetches the reminder once at the top with `select: { id: true, title: true, description: true, active: true }`. The email branch needs `targets { nextDueOn, item { id, name }, system { id, name } }` added. Modify the **single** top-of-function `findUnique` to include the targets relation — keep one query, just widen its `select`.

Replace:
```ts
const reminder = await prisma.reminder.findUnique({
  where: { id: payload.reminderId },
  select: { id: true, title: true, description: true, active: true },
});
```

with:
```ts
const reminder = await prisma.reminder.findUnique({
  where: { id: payload.reminderId },
  select: {
    id: true,
    title: true,
    description: true,
    active: true,
    targets: {
      select: {
        nextDueOn: true,
        item: { select: { id: true, name: true } },
        system: { select: { id: true, name: true } },
      },
    },
  },
});
```

- [ ] **Step 3: Replace the inline email composition with `reminderEmail()` + `APP_URL` guard**

Find the existing `// email` block (the section starting with `if (!user.email)`). Replace the **entire email branch** (from `// email` through the final `notificationLog.update` for the email path) with:

```ts
  // email
  if (!user.email) {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'no email' },
    });
    return;
  }
  if (!env.APP_URL) {
    // Every meaningful link in this email is absolute and needs APP_URL.
    // A reminder email with broken links is worse than a logged skip —
    // self-hosters can see exactly what to configure.
    console.warn(
      `notify: APP_URL not configured; skipping email for reminder ${reminder.id}`,
    );
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'skipped', errorReason: 'APP_URL not configured' },
    });
    return;
  }
  const { subject, html, text } = reminderEmail({
    reminderId: reminder.id,
    title: reminder.title,
    description: reminder.description,
    appUrl: env.APP_URL,
    timezone: prefs.timezone,
    targets: reminder.targets.map((t) => ({
      nextDueOn: t.nextDueOn,
      item: t.item ?? undefined,
      system: t.system ?? undefined,
    })),
  });
  const r = await sendEmail(user.email, { subject, text, html });
  await prisma.notificationLog.update({
    where: { id: logId },
    data: r.ok ? { status: 'sent' } : { status: 'failed', errorReason: r.reason },
  });
}
```

- [ ] **Step 4: Add the import at the top of the file**

Add: `import { reminderEmail } from '@/lib/email/templates/reminder';`

- [ ] **Step 5: Remove the now-unused `escapeHtml` helper**

The previous inline composition needed `escapeHtml` at the bottom of the file. The template handles escaping via React. Delete the `escapeHtml` function definition + its biome-ignore line entirely.

- [ ] **Step 6: Remove the now-unused `const url = ...` line**

The local `url` variable was only used by the email branch's inline string. The push branch builds its own `url` for the push payload — verify before deleting whether `url` is still referenced in the push branch (line ~55 currently). If push uses it, keep it; if not, delete. Read carefully.

(Hint: in the current code at line 55–56 `url` is built once at top of function and used by both the push branch's `sendPush({...url})` and the email branch. After the email rewrite, the push branch still needs `url`. **Keep `url` and just keep using it for push.**)

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If the `targets` mapping complains because Prisma's generated type makes `item`/`system` nullable rather than optional, the `t.item ?? undefined` already normalizes it — error should resolve.

- [ ] **Step 8: Run unit tests to confirm no regression**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add worker/jobs/notify.ts
git commit -m "feat(email): use reminderEmail template + APP_URL guard in notify"
```

---

## Task 5: Extend the notify-job integration test

**Files:**
- Modify: `tests/integration/notify-job.test.ts`

The existing integration test exercises the worker against real Postgres but asserts **nothing** about email content. Add (a) content assertions on the `sendEmail` payload and (b) the new `APP_URL`-unset skip path.

- [ ] **Step 1: Read current `notify-job.test.ts`**

Read the file. Note how it mocks/stubs `sendEmail` today (look for `vi.mock`), how it seeds the user and reminder, and how the email branch is currently driven.

- [ ] **Step 2: Add a payload-capture assertion to an existing email test (or a new one)**

If `sendEmail` is currently mocked, modify the mock to capture the payload it was called with. Add a test that:
1. Seeds a reminder with a `targets[]` containing one item.
2. Seeds a user with `email` set and `emailEnabled: true` in `notificationPrefs`.
3. Sets `APP_URL` in the test env (via the existing per-test env mock).
4. Invokes `handleNotify({ channel: 'email', ... })`.
5. Asserts the captured `sendEmail` call: `subject` matches `^Reminder: `, `html` contains the reminder title AND the item link `${APP_URL}/items/<id>` AND `View reminder`, and `text` is non-empty and contains the title.

If `sendEmail` is **not** currently mocked, this requires adding a `vi.mock('@/lib/notifications/email', ...)` per the existing project mock pattern (see `tests/integration/notify-job.test.ts` for whether such a mock already exists — if not, follow the same dynamic-import-in-`beforeAll` pattern used in other integration tests for module-load DATABASE_URL safety).

```ts
// Skeleton (adapt to existing test-file structure):
it('composes a reminder email with title, target link, and CTA', async () => {
  // ... arrange: seed user with email + emailEnabled, reminder with item target
  process.env.APP_URL = 'https://test.hm';
  // ... call handleNotify
  expect(sendEmailMock).toHaveBeenCalledOnce();
  const [to, payload] = sendEmailMock.mock.calls[0]!;
  expect(to).toBe('user@example.com');
  expect(payload.subject).toMatch(/^Reminder: /);
  expect(payload.html).toContain(/* reminder title */);
  expect(payload.html).toMatch(/href="https:\/\/test\.hm\/items\/[^"]+"/);
  expect(payload.html).toContain('View reminder');
  expect(payload.text.length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Add the `APP_URL`-unset skip-path test**

```ts
it('marks the log skipped with reason "APP_URL not configured" when APP_URL is unset', async () => {
  // ... arrange: seed user with email + emailEnabled, reminder with item target
  delete process.env.APP_URL; // or set to '' depending on env-mock shape
  // ... call handleNotify with channel: 'email'
  expect(sendEmailMock).not.toHaveBeenCalled();
  const log = await prisma.notificationLog.findFirst({
    where: { reminderId: reminder.id, channel: 'email' },
  });
  expect(log?.status).toBe('skipped');
  expect(log?.errorReason).toBe('APP_URL not configured');
});
```

- [ ] **Step 4: Run integration tests**

Run: `pnpm test:integration`
Expected: PASS for all notify-job cases plus the two new ones. If module-load DATABASE_URL trap bites, follow the dynamic-import-in-`beforeAll` pattern already used elsewhere in `tests/integration/`.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/notify-job.test.ts
git commit -m "test(email): assert reminder email content + APP_URL skip path"
```

---

## Task 6: Final verify + finishing

- [ ] **Step 1: Run the full verify suite**

Run: `pnpm verify`
Expected: lint + typecheck + unit — all green.

- [ ] **Step 2: Run integration suite**

Run: `pnpm test:integration`
Expected: all green.

- [ ] **Step 3: Run E2E suite**

Run: `pnpm test:e2e`
Expected: all green (no new E2E added; existing E2E should be unaffected since email path isn't user-facing in browser).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Smoke render a reminder email manually (optional but recommended)**

Quick sanity:
```bash
pnpm exec tsx -e "
import { reminderEmail } from './lib/email/templates/reminder';
const r = reminderEmail({
  reminderId: 'rem_demo',
  title: 'Replace furnace filter',
  description: 'MERV-13 monthly',
  appUrl: 'https://hm.example',
  timezone: 'America/New_York',
  targets: [{ nextDueOn: new Date(), item: { id: 'itm_demo', name: 'Furnace' } }],
});
console.log('SUBJECT:', r.subject);
console.log('HTML:'); console.log(r.html);
console.log('TEXT:'); console.log(r.text);
"
```
Eyeball the HTML — open `r.html` in a browser if you want to see the rendered card. Confirm:
- Title in the body (not just subject)
- Item link present with absolute href
- "View reminder" button
- Footer settings link
- No `<style>` tag, no `class=` attributes

- [ ] **Step 6: Hand off to `superpowers:finishing-a-development-branch`**

Invoke that skill to push the branch and open the PR with the manual smoke checklist:
- Send a real reminder email in a local stack (worker + APP_URL set) and visually inspect the result in a real client (Gmail, Apple Mail, etc.)
- Force the `APP_URL`-unset path locally and verify the `NotificationLog` row has `status='skipped'` and `errorReason='APP_URL not configured'`

---

## Cadence reminders

- One combined-reviewer Haiku review per task before marking the task complete (per `feedback_execution_cadence`).
- Don't push during execution; the branch accumulates and the push happens via `finishing-a-development-branch`.
- All commits signed (1Password handles auto-approval automatically; don't pass `-c user.email=...` or `--no-verify`).
- Stage explicit paths (never `git add -A`).
- For Task 5 specifically: if any module-load DATABASE_URL surprise appears, fall back to the dynamic-import-in-`beforeAll` pattern that other `tests/integration/*.test.ts` files use.
