import { describe, expect, it } from 'vitest';
import type { DigestEntry, DigestGroup } from '@/lib/digests/group';
import { asCalendarDate } from '@/lib/time/tz';
import { type DigestEmailData, digestEmail } from './digest';

function baseEntry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    reminderId: 'rem_1',
    title: 'Replace filter',
    dueOn: asCalendarDate(new Date('2026-06-01T00:00:00Z')),
    daysOverdue: 0,
    targets: [{ kind: 'item' as const, id: 'itm_1', name: 'Furnace' }],
    ...over,
  };
}

function baseGroup(over: Partial<DigestGroup> = {}): DigestGroup {
  return { system: { id: 'sys_1', name: 'HVAC' }, entries: [baseEntry()], ...over };
}

function baseData(over: Partial<DigestEmailData> = {}): DigestEmailData {
  return {
    mode: 'overdue',
    groups: [baseGroup({ entries: [baseEntry({ daysOverdue: 3 })] })],
    appUrl: 'https://hm.example',
    ...over,
  };
}

describe('digestEmail', () => {
  it('builds an overdue subject with the count and pluralization', () => {
    expect(
      digestEmail(baseData({ groups: [baseGroup({ entries: [baseEntry({ daysOverdue: 1 })] })] }))
        .subject,
    ).toBe('Overdue: 1 reminder');
    expect(
      digestEmail(
        baseData({
          groups: [
            baseGroup({
              entries: [
                baseEntry({ daysOverdue: 1 }),
                baseEntry({ reminderId: 'r2', title: 'X', daysOverdue: 2 }),
              ],
            }),
          ],
        }),
      ).subject,
    ).toBe('Overdue: 2 reminders');
  });

  it('builds a weekly subject with the count and pluralization', () => {
    const { subject } = digestEmail(
      baseData({ mode: 'weekly', groups: [baseGroup({ entries: [baseEntry()] })] }),
    );
    expect(subject).toBe('This week: 1 reminder due');
  });

  it('renders the correct H1 per mode', () => {
    expect(digestEmail(baseData({ mode: 'overdue' })).html).toContain('Overdue reminders');
    expect(digestEmail(baseData({ mode: 'weekly' })).html).toContain('Reminders due this week');
  });

  it('renders items in the order given (template never re-sorts)', () => {
    const { html } = digestEmail(
      baseData({
        groups: [
          baseGroup({
            entries: [
              baseEntry({ reminderId: 'a', title: 'Aaa', daysOverdue: 1 }),
              baseEntry({ reminderId: 'b', title: 'Bbb', daysOverdue: 5 }),
            ],
          }),
        ],
      }),
    );
    expect(html.indexOf('Aaa')).toBeLessThan(html.indexOf('Bbb'));
  });

  it('renders an "Xd overdue" badge in overdue mode', () => {
    const { html } = digestEmail(
      baseData({
        mode: 'overdue',
        groups: [baseGroup({ entries: [baseEntry({ daysOverdue: 7 })] })],
      }),
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
        groups: [
          baseGroup({
            entries: [baseEntry({ dueOn: asCalendarDate(new Date('2026-07-15T00:00:00Z')) })],
          }),
        ],
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
        groups: [
          baseGroup({
            entries: [baseEntry({ targets: [{ kind: 'item', id: 'itm_1', name: 'Furnace' }] })],
          }),
        ],
      }),
    ).html;
    expect(itemHtml).toContain('href="https://hm.example/items/itm_1"');

    const sysHtml = digestEmail(
      baseData({
        groups: [
          baseGroup({
            entries: [baseEntry({ targets: [{ kind: 'system', id: 'sys_1', name: 'HVAC' }] })],
          }),
        ],
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
      baseData({
        groups: [baseGroup({ entries: [baseEntry({ title: '<script>alert(1)</script>Foo' })] })],
      }),
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

  it('throws when called with an empty groups array (handler should skip first)', () => {
    expect(() => digestEmail(baseData({ groups: [] }))).toThrow(/non-empty/i);
  });

  it('renders the system name as a heading in both html and text', () => {
    const { html, text } = digestEmail(
      baseData({ groups: [baseGroup({ system: { id: 'sys_9', name: 'Plumbing' } })] }),
    );
    expect(html).toContain('Plumbing');
    expect(text).toContain('Plumbing');
  });

  it('renders "Unassigned" as the heading for a null-system group in both html and text', () => {
    const { html, text } = digestEmail(baseData({ groups: [baseGroup({ system: null })] }));
    expect(html).toContain('Unassigned');
    expect(text).toContain('Unassigned');
  });

  it('counts distinct reminders across two groups sharing a reminderId as one', () => {
    const { subject } = digestEmail(
      baseData({
        groups: [
          baseGroup({
            system: { id: 'sys_1', name: 'HVAC' },
            entries: [baseEntry({ reminderId: 'rem_shared' })],
          }),
          baseGroup({
            system: { id: 'sys_2', name: 'Plumbing' },
            entries: [baseEntry({ reminderId: 'rem_shared' })],
          }),
        ],
      }),
    );
    expect(subject).toBe('Overdue: 1 reminder');
  });

  it('counts a reminder split across two due dates within one group as one', () => {
    const { subject } = digestEmail(
      baseData({
        groups: [
          baseGroup({
            entries: [
              baseEntry({
                reminderId: 'rem_split',
                dueOn: asCalendarDate(new Date('2026-06-01T00:00:00Z')),
              }),
              baseEntry({
                reminderId: 'rem_split',
                dueOn: asCalendarDate(new Date('2026-06-08T00:00:00Z')),
              }),
            ],
          }),
        ],
      }),
    );
    expect(subject).toBe('Overdue: 1 reminder');
  });

  it('renders no target list and no separator dot for an entry with empty targets', () => {
    const { html } = digestEmail(
      baseData({
        mode: 'overdue',
        groups: [baseGroup({ entries: [baseEntry({ targets: [], daysOverdue: 4 })] })],
      }),
    );
    expect(html).not.toContain(' · ');
    expect(html).toMatch(/4d overdue/);
  });
});
