import type { ReactNode } from 'react';
import { formatCalendarDate } from '@/lib/format/date';
import type { CalendarDate } from '@/lib/time/tz';
import { EMAIL_TOKENS, Layout } from '../layout';
import { renderEmail } from '../render';

const T = EMAIL_TOKENS;

type ReminderEmailTarget = {
  nextDueOn: CalendarDate;
  item?: { id: string; name: string };
  system?: { id: string; name: string };
};

export type ReminderEmailData = {
  reminderId: string;
  title: string;
  description: string | null;
  appUrl: string; // guaranteed non-empty by the caller (see notify.ts guard)
  targets: ReminderEmailTarget[];
};

export type ReminderEmailResult = {
  subject: string;
  html: string;
  text: string;
};

/**
 * `nextDueOn` is a calendar date stored at UTC midnight, so it renders in UTC —
 * passing it through the house timezone would shift it a day back in the Americas.
 */
function formatDue(d: CalendarDate): string {
  return formatCalendarDate(d, 'long');
}

type ResolvedTarget = {
  label: string; // item or system name
  href: string; // absolute, appUrl-rooted
  due: string; // the stored calendar date, rendered in UTC
};

function resolveTargets(data: ReminderEmailData): ResolvedTarget[] {
  return data.targets.map((t) => {
    // Schema enforces XOR via parent-XOR check constraint: exactly one of
    // item/system is present per target. If both are missing (shouldn't
    // happen) we fall back to a non-link label so the email still sends.
    if (t.item) {
      return {
        label: t.item.name,
        href: `${data.appUrl}/items/${t.item.id}`,
        due: formatDue(t.nextDueOn),
      };
    }
    if (t.system) {
      return {
        label: t.system.name,
        href: `${data.appUrl}/systems/${t.system.id}`,
        due: formatDue(t.nextDueOn),
      };
    }
    return {
      label: '(no target)',
      href: data.appUrl,
      due: formatDue(t.nextDueOn),
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
        <p style={{ margin: '0 0 16px 0', color: T.ink }}>{data.description}</p>
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
  // Normalize trailing slashes once at the entry point so every downstream
  // href (item/system targets, CTA, footer settings link) and every text URL
  // is built from the same base. APP_URL is z.string().url().optional(), so
  // `https://hm.example/` is a valid input that would otherwise produce
  // `https://hm.example//items/...` when concatenated.
  const normalized: ReminderEmailData = {
    ...data,
    appUrl: data.appUrl.replace(/\/+$/, ''),
  };
  const subject = `Reminder: ${normalized.title}`;
  const { html } = renderEmail(
    <Layout preheader={`Reminder: ${normalized.title}`} appUrl={normalized.appUrl}>
      <Body data={normalized} />
    </Layout>,
  );
  const text = buildText(normalized);
  return { subject, html, text };
}
