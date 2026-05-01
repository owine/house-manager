import { describe, expect, it } from 'vitest';
import { computeNextDueOn, previewOccurrences } from './recurrence';

describe('computeNextDueOn', () => {
  it('interval: returns completedOn + days', () => {
    const completed = new Date('2026-04-30T12:00:00Z');
    const next = computeNextDueOn({ kind: 'interval', days: 60 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('monthly: returns next dayOfMonth strictly after completedOn', () => {
    const completed = new Date('2026-04-10T00:00:00Z');
    const next = computeNextDueOn({ kind: 'monthly', dayOfMonth: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  it('monthly: skips current month if dayOfMonth already passed', () => {
    const completed = new Date('2026-04-20T00:00:00Z');
    const next = computeNextDueOn({ kind: 'monthly', dayOfMonth: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-05-15');
  });

  it('yearly: returns next month/day strictly after completedOn', () => {
    const completed = new Date('2026-03-20T00:00:00Z');
    const next = computeNextDueOn({ kind: 'yearly', month: 3, day: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('yearly: returns same year if not yet passed', () => {
    const completed = new Date('2026-01-10T00:00:00Z');
    const next = computeNextDueOn({ kind: 'yearly', month: 3, day: 15 }, completed);
    expect(next.toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});

describe('previewOccurrences', () => {
  it('returns N future occurrences for interval', () => {
    const occ = previewOccurrences(
      { kind: 'interval', days: 30 },
      new Date('2026-05-01T00:00:00Z'),
      3,
    );
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-05-31',
      '2026-06-30',
      '2026-07-30',
    ]);
  });

  it('returns N future occurrences for monthly', () => {
    const occ = previewOccurrences(
      { kind: 'monthly', dayOfMonth: 15 },
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
