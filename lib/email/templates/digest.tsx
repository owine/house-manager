import type { ReactNode } from 'react';
import { formatCalendarDate } from '@/lib/format/date';
import type { CalendarDate } from '@/lib/time/tz';
import { EMAIL_TOKENS, Layout } from '../layout';
import { renderEmail } from '../render';

const T = EMAIL_TOKENS;

type DigestItemTarget =
  | { kind: 'item'; id: string; name: string }
  | { kind: 'system'; id: string; name: string };

type DigestItem = {
  reminderId: string;
  title: string;
  dueOn: CalendarDate;
  daysOverdue: number;
  targets: DigestItemTarget[];
};

export type DigestEmailData = {
  mode: 'overdue' | 'weekly';
  items: DigestItem[]; // template never re-sorts; query owns order
  appUrl: string;
};

export type DigestEmailResult = { subject: string; html: string; text: string };

/**
 * `dueOn` is a calendar date stored at UTC midnight, so it renders in UTC —
 * passing it through the house timezone would shift it a day back in the Americas.
 * (The house tz still drives digest *scheduling* and the overdue cutoff in the
 * query; it just has no business formatting a date-only value.)
 */
function formatDue(d: CalendarDate): string {
  return formatCalendarDate(d, 'long');
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
          <li key={it.reminderId} style={{ borderTop: `1px solid ${T.line}`, padding: '12px 0' }}>
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
                : `due ${formatDue(it.dueOn)}`}
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
      data.mode === 'overdue' ? `${it.daysOverdue}d overdue` : `due ${formatDue(it.dueOn)}`;
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
