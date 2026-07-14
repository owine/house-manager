import { describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { type DigestEmailData, digestEmail } from './digest';

function baseItem(over: Partial<DigestEmailData['items'][number]> = {}) {
  return {
    reminderId: 'rem_1',
    title: 'Replace filter',
    dueOn: asCalendarDate(new Date('2026-06-01T00:00:00Z')),
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
    ...over,
  };
}

describe('digestEmail', () => {
  it('builds an overdue subject with the count and pluralization', () => {
    expect(digestEmail(baseData({ items: [baseItem({ daysOverdue: 1 })] })).subject).toBe(
      'Overdue: 1 reminder',
    );
    expect(
      digestEmail(
        baseData({
          items: [
            baseItem({ daysOverdue: 1 }),
            baseItem({ reminderId: 'r2', title: 'X', daysOverdue: 2 }),
          ],
        }),
      ).subject,
    ).toBe('Overdue: 2 reminders');
  });

  it('builds a weekly subject with the count and pluralization', () => {
    const { subject } = digestEmail(baseData({ mode: 'weekly', items: [baseItem()] }));
    expect(subject).toBe('This week: 1 reminder due');
  });

  it('renders the correct H1 per mode', () => {
    expect(digestEmail(baseData({ mode: 'overdue' })).html).toContain('Overdue reminders');
    expect(digestEmail(baseData({ mode: 'weekly' })).html).toContain('Reminders due this week');
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

  // `dueOn` is a calendar date stored at UTC midnight, not an instant. Rendering it
  // through a negative-offset tz shifts it a day back — the weekly digest listed a
  // July 15 reminder as "due July 14".
  it('renders a "due {date}" badge in weekly mode using the stored calendar date', () => {
    const { html, text } = digestEmail(
      baseData({
        mode: 'weekly',
        items: [baseItem({ dueOn: asCalendarDate(new Date('2026-07-15T00:00:00Z')) })],
      }),
    );
    expect(html).toContain('due July 15, 2026');
    expect(text).toContain('due July 15, 2026');
    expect(html).not.toContain('July 14, 2026');
  });

  it('links each reminder title to {appUrl}/reminders/{id}', () => {
    const { html } = digestEmail(baseData());
    expect(html).toContain('href="https://hm.example/reminders/rem_1"');
  });

  it('links item targets to /items/{id} and system targets to /systems/{id}', () => {
    const itemHtml = digestEmail(
      baseData({
        items: [baseItem({ targets: [{ kind: 'item', id: 'itm_1', name: 'Furnace' }] })],
      }),
    ).html;
    expect(itemHtml).toContain('href="https://hm.example/items/itm_1"');

    const sysHtml = digestEmail(
      baseData({
        items: [baseItem({ targets: [{ kind: 'system', id: 'sys_1', name: 'HVAC' }] })],
      }),
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
