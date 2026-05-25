import { describe, expect, it } from 'vitest';
import {
  createReminderSchema,
  parseRecurrence,
  recurrenceSchema,
  updateReminderSchema,
} from './schema';

describe('recurrenceSchema', () => {
  it.each([
    [{ kind: 'interval', every: 60, unit: 'day' }, true],
    [{ kind: 'interval', every: 0, unit: 'day' }, false],
    [{ kind: 'interval', every: 3651, unit: 'day' }, false],
    [{ kind: 'interval', every: 60 }, false],
    [{ kind: 'unknown' }, false],
  ])('parses %j → success=%s', (input, expected) => {
    expect(recurrenceSchema.safeParse(input).success).toBe(expected);
  });
});

describe('createReminderSchema', () => {
  it('accepts a complete valid reminder with one item target', () => {
    const r = createReminderSchema.safeParse({
      title: 'Replace HVAC filter',
      description: 'use MERV 13',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      leadTimeDays: 3,
      autoCreateServiceRecord: false,
      kind: 'REMINDER',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a reminder with multiple targets (item + system)', () => {
    const r = createReminderSchema.safeParse({
      title: 'HVAC service',
      targets: [{ itemId: 'cuid-1' }, { systemId: 'cuid-sys-1' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'REMINDER',
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing title', () => {
    const r = createReminderSchema.safeParse({
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty targets array', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  it('rejects target with both itemId and systemId set', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'i', systemId: 's' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  it('rejects target with neither itemId nor systemId set', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{}],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative leadTimeDays', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      leadTimeDays: -1,
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  // Was: "defaults kind to REMINDER when omitted". After the discriminated-union
  // split, kind is required on create — callers must pass it explicitly.
  it('rejects create when kind is omitted (discriminator is required)', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });

  it('accepts kind=CHORE', () => {
    const r = createReminderSchema.safeParse({
      title: 'Take out trash',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 7, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'CHORE',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('CHORE');
  });

  it('rejects unknown kind values', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'TASK',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a chore with zero targets', () => {
    const r = createReminderSchema.safeParse({
      title: 'Take out the trash',
      targets: [],
      recurrence: { kind: 'weekly', weekdays: [1], interval: 1 },
      nextDueOn: new Date(),
      kind: 'CHORE',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a chore with one item target', () => {
    const r = createReminderSchema.safeParse({
      title: 'Run dishwasher cleaner',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', every: 30, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'CHORE',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a reminder with zero targets (existing rule preserved)', () => {
    const r = createReminderSchema.safeParse({
      title: 'HVAC filter',
      targets: [],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
      kind: 'REMINDER',
    });
    expect(r.success).toBe(false);
  });

  it('rejects when kind is omitted and targets are empty (kind required, no chore loophole)', () => {
    const r = createReminderSchema.safeParse({
      title: 'HVAC filter',
      targets: [],
      recurrence: { kind: 'interval', every: 60, unit: 'day' },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });
});

describe('updateReminderSchema', () => {
  it('leaves kind undefined when omitted (no silent flip to REMINDER)', () => {
    const r = updateReminderSchema.safeParse({ id: 'cuid-1', title: 'X' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBeUndefined();
  });

  it('accepts an explicit kind change on update', () => {
    const r = updateReminderSchema.safeParse({ id: 'cuid-1', kind: 'CHORE' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('CHORE');
  });

  it('accepts a chore update with empty targets', () => {
    const r = updateReminderSchema.safeParse({ id: 'cuid-r', targets: [], kind: 'CHORE' });
    expect(r.success).toBe(true);
  });

  it('rejects a reminder update that supplies empty targets', () => {
    const r = updateReminderSchema.safeParse({ id: 'cuid-r', targets: [], kind: 'REMINDER' });
    expect(r.success).toBe(false);
  });

  it('still allows an update that omits targets entirely (no targets change)', () => {
    const r = updateReminderSchema.safeParse({ id: 'cuid-r', title: 'Renamed' });
    expect(r.success).toBe(true);
  });
});

describe('recurrenceSchema — new kinds', () => {
  it('accepts interval with unit', () => {
    expect(recurrenceSchema.safeParse({ kind: 'interval', every: 3, unit: 'month' }).success).toBe(
      true,
    );
  });
  it('accepts weekly with weekdays', () => {
    expect(
      recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1, 4], interval: 1 }).success,
    ).toBe(true);
  });
  it('rejects weekly with empty weekdays', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [], interval: 1 }).success).toBe(
      false,
    );
  });
  it('rejects weekly with duplicate weekdays', () => {
    expect(
      recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1, 1], interval: 1 }).success,
    ).toBe(false);
  });
  it('rejects weekly with out-of-range weekday', () => {
    expect(recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [7], interval: 1 }).success).toBe(
      false,
    );
  });
  it('accepts activeMonths on weekly', () => {
    expect(
      recurrenceSchema.safeParse({
        kind: 'weekly',
        weekdays: [1],
        interval: 1,
        activeMonths: [4, 5, 6],
      }).success,
    ).toBe(true);
  });
  it('rejects empty activeMonths', () => {
    expect(
      recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1], interval: 1, activeMonths: [] })
        .success,
    ).toBe(false);
  });
  it('rejects duplicate activeMonths', () => {
    expect(
      recurrenceSchema.safeParse({
        kind: 'weekly',
        weekdays: [1],
        interval: 1,
        activeMonths: [4, 4],
      }).success,
    ).toBe(false);
  });
  it('rejects out-of-range activeMonths', () => {
    expect(
      recurrenceSchema.safeParse({ kind: 'weekly', weekdays: [1], interval: 1, activeMonths: [13] })
        .success,
    ).toBe(false);
  });
});

describe('parseRecurrence', () => {
  it('normalizes legacy interval {days} to {every, unit:day}', () => {
    expect(parseRecurrence({ kind: 'interval', days: 60 })).toEqual({
      kind: 'interval',
      every: 60,
      unit: 'day',
    });
  });
  it('passes through new interval shape unchanged', () => {
    expect(parseRecurrence({ kind: 'interval', every: 2, unit: 'week' })).toEqual({
      kind: 'interval',
      every: 2,
      unit: 'week',
    });
  });
  it('passes through monthly/yearly/once', () => {
    expect(parseRecurrence({ kind: 'once' })).toEqual({ kind: 'once' });
  });
  it('throws on malformed JSON', () => {
    expect(() => parseRecurrence({ kind: 'interval' })).toThrow();
  });
});

describe('recurrenceSchema — array shapes', () => {
  it.each([
    [{ kind: 'weekly', weekdays: [1], interval: 2 }, true],
    [{ kind: 'weekly', weekdays: [1] }, false],
    [{ kind: 'weekly', weekdays: [1], interval: 0 }, false],
    [{ kind: 'weekly', weekdays: [1], interval: 53 }, false],
    [{ kind: 'weekly', weekdays: [1], interval: 2, anchor: '2026-05-19' }, true],
    [{ kind: 'monthly', days: [1, 15], last: false }, true],
    [{ kind: 'monthly', days: [], last: true }, true],
    [{ kind: 'monthly', days: [], last: false }, false],
    [{ kind: 'monthly', days: [1, 1], last: false }, false],
    [{ kind: 'monthly', days: [29], last: false }, false],
    [
      {
        kind: 'monthlyWeekday',
        combos: [
          { week: 1, weekday: 1 },
          { week: 3, weekday: 1 },
        ],
      },
      true,
    ],
    [{ kind: 'monthlyWeekday', combos: [] }, false],
    [
      {
        kind: 'monthlyWeekday',
        combos: [
          { week: 1, weekday: 1 },
          { week: 1, weekday: 1 },
        ],
      },
      false,
    ],
    [{ kind: 'monthlyWeekday', combos: [{ week: 0, weekday: 1 }] }, false],
    [
      {
        kind: 'yearly',
        dates: [
          { month: 1, day: 1 },
          { month: 7, day: 1 },
        ],
      },
      true,
    ],
    [{ kind: 'yearly', dates: [{ month: 1, day: 31 }] }, true],
    [{ kind: 'yearly', dates: [] }, false],
    [
      {
        kind: 'yearly',
        dates: [
          { month: 1, day: 1 },
          { month: 1, day: 1 },
        ],
      },
      false,
    ],
    [{ kind: 'yearly', dates: [{ month: 13, day: 1 }] }, false],
    [{ kind: 'yearly', dates: [{ month: 1, day: 32 }] }, false],
  ])('parses %j → success=%s', (input, expected) => {
    expect(recurrenceSchema.safeParse(input).success).toBe(expected);
  });
});

describe('parseRecurrence — legacy normalization', () => {
  it('weekly without interval → interval 1', () => {
    expect(parseRecurrence({ kind: 'weekly', weekdays: [1] })).toEqual({
      kind: 'weekly',
      weekdays: [1],
      interval: 1,
    });
  });
  it('monthly dayOfMonth number → days[]', () => {
    expect(parseRecurrence({ kind: 'monthly', dayOfMonth: 15 })).toEqual({
      kind: 'monthly',
      days: [15],
      last: false,
    });
  });
  it("monthly dayOfMonth 'last' → last:true", () => {
    expect(parseRecurrence({ kind: 'monthly', dayOfMonth: 'last' })).toEqual({
      kind: 'monthly',
      days: [],
      last: true,
    });
  });
  it('monthlyWeekday single → combos[]', () => {
    expect(parseRecurrence({ kind: 'monthlyWeekday', week: -1, weekday: 5 })).toEqual({
      kind: 'monthlyWeekday',
      combos: [{ week: -1, weekday: 5 }],
    });
  });
  it('yearly single → dates[]', () => {
    expect(parseRecurrence({ kind: 'yearly', month: 4, day: 15 })).toEqual({
      kind: 'yearly',
      dates: [{ month: 4, day: 15 }],
    });
  });
  it('legacy interval {days:N} still maps to {every,unit}', () => {
    expect(parseRecurrence({ kind: 'interval', days: 30 })).toEqual({
      kind: 'interval',
      every: 30,
      unit: 'day',
    });
  });
  it('preserves activeMonths through monthly normalization', () => {
    expect(parseRecurrence({ kind: 'monthly', dayOfMonth: 1, activeMonths: [7] })).toEqual({
      kind: 'monthly',
      days: [1],
      last: false,
      activeMonths: [7],
    });
  });
});
