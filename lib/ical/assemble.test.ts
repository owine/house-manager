import { describe, expect, it } from 'vitest';
import { assembleReminderEvents } from './assemble';

const NOW = new Date('2026-05-21T00:00:00Z');

function base(overrides: Partial<Parameters<typeof assembleReminderEvents>[0]> = {}) {
  return {
    id: 'r1',
    title: 'Replace HVAC filter',
    description: 'use MERV 13',
    leadTimeDays: 3,
    completions: [] as Date[],
    recurrence: { kind: 'once' as const },
    nextDueOn: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('assembleReminderEvents', () => {
  it('recurring: emits a ✅ event per completion + the due event + 11 projections', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
        completions: [new Date('2026-04-04T09:00:00Z'), new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
      'UTC',
    );
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'due')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'projected')).toHaveLength(11);
  });

  it('completed events carry the ✅ prefix, no alarm, and the completedOn date', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
        completions: [new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
      'UTC',
    );
    const done = events.find((e) => e.kind === 'completed');
    expect(done).toBeDefined();
    expect(done?.title).toBe('✅ Replace HVAC filter');
    expect(done?.alarmSecondsBefore).toBeNull();
    expect(done?.date.toISOString().slice(0, 10)).toBe('2026-05-04');
    expect(done?.reminderId).toBe('r1');
  });

  it('completed one-shot: suppresses the sentinel due event, keeps the ✅', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'once' },
        nextDueOn: new Date('9999-12-31T00:00:00.000Z'),
        completions: [new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
      'UTC',
    );
    expect(events.filter((e) => e.kind === 'due')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'projected')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(1);
  });

  it('active one-shot: one plain due event, no projections', () => {
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-06-01T00:00:00Z') }),
      NOW,
      'UTC',
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('due');
    expect(events[0].title).toBe('Replace HVAC filter');
  });

  it('overdue due date (past): plain title, no alarm', () => {
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-05-10T00:00:00Z') }),
      NOW,
      'UTC',
    );
    const due = events.find((e) => e.kind === 'due');
    expect(due).toBeDefined();
    expect(due?.title).toBe('Replace HVAC filter');
    expect(due?.alarmSecondsBefore).toBeNull();
  });

  it('future due date: carries a lead-time alarm in seconds', () => {
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-06-01T00:00:00Z') }),
      NOW,
      'UTC',
    );
    expect(events.find((e) => e.kind === 'due')?.alarmSecondsBefore).toBe(3 * 86_400);
  });

  it('two completions on the same UTC day produce exactly ONE completed event (deduped)', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
        completions: [new Date('2026-05-04T10:00:00Z'), new Date('2026-05-04T14:00:00Z')],
      }),
      NOW,
      'UTC',
    );
    const completed = events.filter((e) => e.kind === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBeDefined();
    expect(completed[0]?.uid).toBe('reminder-r1-done-2026-05-04');
    expect(completed[0]?.date.toISOString().slice(0, 10)).toBe('2026-05-04');
  });

  it('completions on different UTC days each produce one completed event', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
        completions: [new Date('2026-04-04T09:00:00Z'), new Date('2026-05-04T10:00:00Z')],
      }),
      NOW,
      'UTC',
    );
    const completed = events.filter((e) => e.kind === 'completed');
    expect(completed).toHaveLength(2);
    expect(completed[0]?.date.toISOString().slice(0, 10)).toBe('2026-04-04');
    expect(completed[1]?.date.toISOString().slice(0, 10)).toBe('2026-05-04');
  });

  it('due date same UTC day as now but mid-day now: still gets an alarm', () => {
    const midDayNow = new Date('2026-05-21T14:00:00Z');
    const events = assembleReminderEvents(
      base({ recurrence: { kind: 'once' }, nextDueOn: new Date('2026-05-21T00:00:00Z') }),
      midDayNow,
      'UTC',
    );
    const due = events.find((e) => e.kind === 'due');
    expect(due).toBeDefined();
    expect(due?.alarmSecondsBefore).toBe(3 * 86_400);
  });

  it('projected UIDs contain -proj- and are distinct from the due UID', () => {
    const events = assembleReminderEvents(
      base({
        recurrence: { kind: 'interval', every: 30, unit: 'day' },
        nextDueOn: new Date('2026-06-30T00:00:00Z'),
      }),
      NOW,
      'UTC',
    );
    const due = events.find((e) => e.kind === 'due');
    expect(due).toBeDefined();
    expect(due?.uid).not.toContain('-proj-');
    const projected = events.filter((e) => e.kind === 'projected');
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.every((e) => e.uid.includes('-proj-'))).toBe(true);
  });

  it('null description becomes empty string on every event', () => {
    const events = assembleReminderEvents(
      base({
        description: null,
        recurrence: { kind: 'once' },
        nextDueOn: new Date('2026-06-01T00:00:00Z'),
      }),
      NOW,
      'UTC',
    );
    expect(events.every((e) => e.description === '')).toBe(true);
  });

  it('due-today in NY tz keeps lead-time alarm', () => {
    // nextDueOn = 2026-05-27T00:00:00Z (date-only, UTC midnight — production shape)
    // now       = 2026-05-27T20:00:00Z = 2026-05-27 16:00 EDT (afternoon New York)
    // Due date is the 27th, today in NY is the 27th → NOT overdue → alarm should fire
    const nyNow = new Date('2026-05-27T20:00:00Z');
    const events = assembleReminderEvents(
      base({
        leadTimeDays: 3,
        recurrence: { kind: 'once' },
        nextDueOn: new Date(Date.UTC(2026, 4, 27)),
      }),
      nyNow,
      'America/New_York',
    );
    const due = events.find((e) => e.kind === 'due');
    expect(due).toBeDefined();
    expect(due?.alarmSecondsBefore).toBe(259200); // 3 * 86400
  });

  it('due-yesterday in NY tz has no alarm', () => {
    // nextDueOn = 2026-05-26T00:00:00Z (date-only, UTC midnight — production shape)
    // now       = 2026-05-27T20:00:00Z = 2026-05-27 16:00 EDT (today in NY)
    // Due date is the 26th, today in NY is the 27th → overdue → no alarm
    const nyNow = new Date('2026-05-27T20:00:00Z');
    const events = assembleReminderEvents(
      base({
        leadTimeDays: 3,
        recurrence: { kind: 'once' },
        nextDueOn: new Date(Date.UTC(2026, 4, 26)),
      }),
      nyNow,
      'America/New_York',
    );
    const due = events.find((e) => e.kind === 'due');
    expect(due).toBeDefined();
    expect(due?.alarmSecondsBefore).toBeNull();
  });

  it('UTC+ tz diverges from the old UTC-midnight check (Auckland regression guard)', () => {
    // The realistic stored shape: nextDueOn is at 00:00:00Z.
    // nextDueOn = 2026-05-26T00:00:00Z → Auckland (UTC+12) = May 26 12:00 local
    // now       = 2026-05-26T15:00:00Z → Auckland (UTC+12) = May 27 03:00 local
    // Auckland calendar day for due is May 26; for now is May 27 → OVERDUE → no alarm.
    // Under the old `utcMidnight(due) >= utcMidnight(now)` check both UTC dates are
    // May 26 → alarm would fire incorrectly. This test fails on the old code path.
    const aklNow = new Date('2026-05-26T15:00:00Z');
    const events = assembleReminderEvents(
      base({
        leadTimeDays: 3,
        recurrence: { kind: 'once' },
        nextDueOn: new Date('2026-05-26T00:00:00Z'),
      }),
      aklNow,
      'Pacific/Auckland',
    );
    const due = events.find((e) => e.kind === 'due');
    expect(due).toBeDefined();
    expect(due?.alarmSecondsBefore).toBeNull();
  });
});
