import { describe, expect, it } from 'vitest';
import { describeRecurrence } from './describe';

describe('describeRecurrence', () => {
  it('interval day', () =>
    expect(describeRecurrence({ kind: 'interval', every: 60, unit: 'day' })).toBe('Every 60 days'));
  it('interval singular', () =>
    expect(describeRecurrence({ kind: 'interval', every: 1, unit: 'week' })).toBe('Every week'));
  it('interval month plural', () =>
    expect(describeRecurrence({ kind: 'interval', every: 3, unit: 'month' })).toBe(
      'Every 3 months',
    ));
  it('weekly multi', () =>
    expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 4] })).toBe('Every Mon & Thu'));
  it('monthly day', () =>
    expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 15 })).toBe('Monthly on the 15th'));
  it('monthly last', () =>
    expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 'last' })).toBe(
      'Last day of the month',
    ));
  it('monthlyWeekday last', () =>
    expect(describeRecurrence({ kind: 'monthlyWeekday', week: -1, weekday: 5 })).toBe(
      'Last Friday of the month',
    ));
  it('yearly', () =>
    expect(describeRecurrence({ kind: 'yearly', month: 4, day: 15 })).toBe(
      'Every year on April 15',
    ));
  it('once', () => expect(describeRecurrence({ kind: 'once' })).toBe('Once (does not repeat)'));
  it('season suffix', () =>
    expect(
      describeRecurrence({
        kind: 'interval',
        every: 2,
        unit: 'week',
        activeMonths: [4, 5, 6, 7, 8, 9, 10],
      }),
    ).toBe('Every 2 weeks (Apr–Oct)'));
  it('non-contiguous season suffix', () =>
    expect(describeRecurrence({ kind: 'weekly', weekdays: [1], activeMonths: [3, 6, 9, 12] })).toBe(
      'Every Mon (Mar, Jun, Sep, Dec)',
    ));
  it('wrap-around season suffix (Nov–Feb)', () =>
    expect(
      describeRecurrence({ kind: 'monthly', dayOfMonth: 1, activeMonths: [11, 12, 1, 2] }),
    ).toBe('Monthly on the 1st (Nov–Feb)'));
  it('single-month season suffix', () =>
    expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 1, activeMonths: [7] })).toBe(
      'Monthly on the 1st (Jul)',
    ));
});
