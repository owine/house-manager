import { describe, expect, it } from 'vitest';
import { computeNextDueOn, FAR_FUTURE, isSentinelDate, previewOccurrences } from './recurrence';
import type { Recurrence } from './schema';

describe('computeNextDueOn', () => {
  it('interval: returns completedOn + days', () => {
    const completed = new Date('2026-04-30T12:00:00Z');
    const next = computeNextDueOn({ kind: 'interval', every: 60, unit: 'day' }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('monthly: returns next dayOfMonth strictly after completedOn', () => {
    const completed = new Date('2026-04-10T00:00:00Z');
    const next = computeNextDueOn({ kind: 'monthly', days: [15], last: false }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  it('monthly: skips current month if dayOfMonth already passed', () => {
    const completed = new Date('2026-04-20T00:00:00Z');
    const next = computeNextDueOn({ kind: 'monthly', days: [15], last: false }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-15');
  });

  it('yearly: returns next month/day strictly after completedOn', () => {
    const completed = new Date('2026-03-20T00:00:00Z');
    const next = computeNextDueOn({ kind: 'yearly', dates: [{ month: 3, day: 15 }] }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('yearly: returns same year if not yet passed', () => {
    const completed = new Date('2026-01-10T00:00:00Z');
    const next = computeNextDueOn({ kind: 'yearly', dates: [{ month: 3, day: 15 }] }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('once: returns the far-future sentinel so the reminder never re-fires', () => {
    const completed = new Date('2026-05-11T00:00:00Z');
    const next = computeNextDueOn({ kind: 'once' }, completed);
    expect(next.getUTCFullYear()).toBe(9999);
  });
});

describe('computeNextDueOn — normalizes to UTC midnight', () => {
  const noon = new Date('2026-05-12T13:37:42.123Z'); // a Tuesday, afternoon
  it('interval day strips time-of-day', () => {
    const d = computeNextDueOn({ kind: 'interval', every: 10, unit: 'day' }, noon);
    expect(d.toISOString()).toBe('2026-05-22T00:00:00.000Z');
  });
  it('weekly strips time-of-day', () => {
    const d = computeNextDueOn({ kind: 'weekly', weekdays: [1], interval: 1 }, noon); // next Mon
    expect(d.toISOString()).toBe('2026-05-18T00:00:00.000Z');
  });
  it('monthly strips time-of-day', () => {
    const d = computeNextDueOn({ kind: 'monthly', days: [15], last: false }, noon);
    expect(d.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });
  it('interval month-end keeps the clamped date at midnight', () => {
    const d = computeNextDueOn(
      { kind: 'interval', every: 1, unit: 'month' },
      new Date('2026-01-31T18:00:00Z'),
    );
    expect(d.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
});

describe('previewOccurrences', () => {
  it('returns N future occurrences for interval', () => {
    const occ = previewOccurrences(
      { kind: 'interval', every: 30, unit: 'day' },
      new Date('2026-05-01T00:00:00Z'),
      3,
    );
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-05-31',
      '2026-06-30',
      '2026-07-30',
    ]);
  });

  it('once: emits no future occurrences (caller already has nextDueOn)', () => {
    const occ = previewOccurrences({ kind: 'once' }, new Date('2026-05-01T00:00:00Z'), 5);
    expect(occ).toEqual([]);
  });

  it('returns N future occurrences for monthly', () => {
    const occ = previewOccurrences(
      { kind: 'monthly', days: [15], last: false },
      new Date('2026-05-01T00:00:00Z'),
      3,
    );
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-05-15',
      '2026-06-15',
      '2026-07-15',
    ]);
  });
});

describe('computeNextDueOn — units', () => {
  it('interval week: +N weeks (calendar)', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 2, unit: 'week' },
      new Date('2026-04-30T12:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-14');
  });
  it('interval month: same day-of-month +N months', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 3, unit: 'month' },
      new Date('2026-01-15T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
  });
  it('interval year: +N years', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 1, unit: 'year' },
      new Date('2026-02-10T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2027-02-10');
  });

  it('interval month: clamps Jan 31 + 1 month to Feb 28 (non-leap)', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 1, unit: 'month' },
      new Date('2026-01-31T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
  });
  it('interval month: Jan 31 + 1 month in a leap year -> Feb 29', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 1, unit: 'month' },
      new Date('2028-01-31T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2028-02-29');
  });
  it('interval month: Mar 31 + 1 month -> Apr 30', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 1, unit: 'month' },
      new Date('2026-03-31T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-30');
  });
  it('interval year: Feb 29 + 1 year clamps to Feb 28', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 1, unit: 'year' },
      new Date('2028-02-29T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2029-02-28');
  });
});

describe('computeNextDueOn — weekly', () => {
  it('single weekday: next Monday after a Tuesday completion', () => {
    const next = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], interval: 1 },
      new Date('2026-05-12T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
  it('multi weekday: Mon & Thu — completing Tue gives Thu', () => {
    const next = computeNextDueOn(
      { kind: 'weekly', weekdays: [1, 4], interval: 1 },
      new Date('2026-05-12T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-14');
  });
  it('wraps to next week: completing Fri with Mon-only', () => {
    const next = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], interval: 1 },
      new Date('2026-05-15T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
});

describe('computeNextDueOn — monthlyWeekday', () => {
  it('first Monday', () => {
    const next = computeNextDueOn(
      { kind: 'monthlyWeekday', combos: [{ week: 1, weekday: 1 }] },
      new Date('2026-05-10T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-01');
  });
  it('last Friday', () => {
    const next = computeNextDueOn(
      { kind: 'monthlyWeekday', combos: [{ week: -1, weekday: 5 }] },
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-29');
  });
});

describe('computeNextDueOn — monthly last day', () => {
  it("'last' lands on the final day of the month", () => {
    const next = computeNextDueOn(
      { kind: 'monthly', days: [], last: true },
      new Date('2026-02-10T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('computeNextDueOn — seasonality', () => {
  it('interval jumps off-season to next in-season month', () => {
    const next = computeNextDueOn(
      { kind: 'interval', every: 2, unit: 'week', activeMonths: [4, 5, 6, 7, 8, 9, 10] },
      new Date('2026-10-25T00:00:00Z'),
    );
    const m = next.getUTCMonth() + 1;
    expect(m).toBeGreaterThanOrEqual(4);
    expect(m).toBeLessThanOrEqual(10);
    expect(next.getUTCFullYear()).toBe(2027);
  });
  it('weekly with bymonth filter only fires in active months', () => {
    const next = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], interval: 1, activeMonths: [11, 12, 1, 2] },
      new Date('2026-05-12T00:00:00Z'),
    );
    expect(next.getUTCMonth() + 1).toBe(11);
  });
  it('omitted activeMonths is year-round (unchanged)', () => {
    const next = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], interval: 1 },
      new Date('2026-05-12T00:00:00Z'),
    );
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
});

describe('computeNextDueOn — multi-value & bi-weekly', () => {
  it('weekly interval 1 unchanged: next Monday after a Tuesday', () => {
    const d = computeNextDueOn(
      { kind: 'weekly', weekdays: [1], interval: 1 },
      new Date('2026-05-12T00:00:00Z'),
    );
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
  it('weekly interval 2 (every other Tuesday) holds parity from anchor', () => {
    const rec = { kind: 'weekly' as const, weekdays: [2], interval: 2, anchor: '2026-05-19' };
    const d1 = computeNextDueOn(rec, new Date('2026-05-19T00:00:00Z'));
    expect(d1.toISOString().slice(0, 10)).toBe('2026-06-02');
    const d2 = computeNextDueOn(rec, new Date('2026-05-21T00:00:00Z'));
    expect(d2.toISOString().slice(0, 10)).toBe('2026-06-02');
  });
  it('monthly multi-day: 1 & 15 picks the nearest upcoming', () => {
    const rec = { kind: 'monthly' as const, days: [1, 15], last: false };
    expect(computeNextDueOn(rec, new Date('2026-05-03T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-05-15',
    );
    expect(computeNextDueOn(rec, new Date('2026-05-16T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-06-01',
    );
  });
  it('monthly days + last: last-day competes with explicit days', () => {
    const rec = { kind: 'monthly' as const, days: [15], last: true };
    expect(computeNextDueOn(rec, new Date('2026-05-16T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-05-31',
    );
  });
  it('monthlyWeekday combos: first & third Monday', () => {
    const rec: Recurrence = {
      kind: 'monthlyWeekday',
      combos: [
        { week: 1, weekday: 1 },
        { week: 3, weekday: 1 },
      ],
    };
    const first = computeNextDueOn(rec, new Date('2026-05-01T00:00:00Z'));
    expect(first.toISOString().slice(0, 10)).toBe('2026-05-04');
    const next = computeNextDueOn(rec, first);
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
  it('monthlyWeekday mixed combos: first Monday + last Friday', () => {
    const rec: Recurrence = {
      kind: 'monthlyWeekday',
      combos: [
        { week: 1, weekday: 1 },
        { week: -1, weekday: 5 },
      ],
    };
    expect(computeNextDueOn(rec, new Date('2026-05-05T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-05-29',
    );
  });
  it('yearly multi-date: Jan 1 & Jul 1 alternates', () => {
    const rec = {
      kind: 'yearly' as const,
      dates: [
        { month: 1, day: 1 },
        { month: 7, day: 1 },
      ],
    };
    const a = computeNextDueOn(rec, new Date('2026-03-01T00:00:00Z'));
    expect(a.toISOString().slice(0, 10)).toBe('2026-07-01');
    const b = computeNextDueOn(rec, a);
    expect(b.toISOString().slice(0, 10)).toBe('2027-01-01');
  });
  it('yearly clamps impossible day: Feb 31 → Feb 28 (2026 non-leap)', () => {
    const rec = { kind: 'yearly' as const, dates: [{ month: 2, day: 31 }] };
    expect(computeNextDueOn(rec, new Date('2026-01-01T00:00:00Z')).toISOString().slice(0, 10)).toBe(
      '2026-02-28',
    );
  });
  it('previewOccurrences alternates a multi-date yearly recurrence', () => {
    const rec = {
      kind: 'yearly' as const,
      dates: [
        { month: 1, day: 1 },
        { month: 7, day: 1 },
      ],
    };
    const occ = previewOccurrences(rec, new Date('2026-03-01T00:00:00Z'), 4).map((d) =>
      d.toISOString().slice(0, 10),
    );
    expect(occ).toEqual(['2026-07-01', '2027-01-01', '2027-07-01', '2028-01-01']);
  });
});

describe('isSentinelDate', () => {
  it('is true for the far-future sentinel a completed one-shot produces', () => {
    const next = computeNextDueOn({ kind: 'once' }, new Date('2026-05-11T00:00:00Z'));
    expect(isSentinelDate(next)).toBe(true);
    expect(isSentinelDate(FAR_FUTURE)).toBe(true);
  });

  it('is false for a normal due date', () => {
    expect(isSentinelDate(new Date('2026-06-30T00:00:00Z'))).toBe(false);
  });
});
