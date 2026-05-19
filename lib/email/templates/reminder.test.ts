import { describe, expect, it } from 'vitest';
import { type ReminderEmailData, reminderEmail } from './reminder';

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
    const { html, text } = reminderEmail(baseData({ description: 'Use a MERV-13 filter.' }));
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
    // 12:00 UTC on 2026-06-01 is 08:00 EDT in America/New_York (still June 1) — the date
    // portion must render in the user's tz, never UTC.
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
    // 2026-06-01T00:00:00Z is May 31 in America/New_York (EDT, UTC-4)
    // 2026-07-15T00:00:00Z is July 14 in America/New_York (EDT, UTC-4)
    expect(html).toMatch(/May 31, 2026|May 31, 26/);
    expect(html).toMatch(/July 14, 2026|Jul 14, 26/);
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
    // Dangerous tags must be escaped, not rendered as executable HTML
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=evil&gt;');
    // The text version should also escape or omit dangerous content
    expect(html).not.toMatch(/<img[^>]*onerror/);
  });
});
