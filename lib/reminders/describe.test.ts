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
    expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 4], interval: 1 })).toBe(
      'Every Mon & Thu',
    ));
  it('weekly every other single weekday', () =>
    expect(describeRecurrence({ kind: 'weekly', weekdays: [2], interval: 2 })).toBe(
      'Every other Tuesday',
    ));
  it('weekly interval >2 multi', () =>
    expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 3], interval: 3 })).toBe(
      'Every 3 weeks on Mon & Wed',
    ));
  it('weekly interval 1 multi unchanged', () =>
    expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 4], interval: 1 })).toBe(
      'Every Mon & Thu',
    ));
  it('monthly day', () =>
    expect(describeRecurrence({ kind: 'monthly', days: [15], last: false })).toBe(
      'Monthly on the 15th',
    ));
  it('monthly multi-day', () =>
    expect(describeRecurrence({ kind: 'monthly', days: [1, 15], last: false })).toBe(
      'Monthly on the 1st & 15th',
    ));
  it('monthly days + last', () =>
    expect(describeRecurrence({ kind: 'monthly', days: [15], last: true })).toBe(
      'Monthly on the 15th + last day',
    ));
  it('monthly only last', () =>
    expect(describeRecurrence({ kind: 'monthly', days: [], last: true })).toBe(
      'Last day of the month',
    ));
  it('monthlyWeekday last', () =>
    expect(describeRecurrence({ kind: 'monthlyWeekday', combos: [{ week: -1, weekday: 5 }] })).toBe(
      'Last Friday of the month',
    ));
  it('monthlyWeekday combos', () =>
    expect(
      describeRecurrence({
        kind: 'monthlyWeekday',
        combos: [
          { week: 1, weekday: 1 },
          { week: 3, weekday: 1 },
        ],
      }),
    ).toBe('First & Third Monday of the month'));
  it('monthlyWeekday mixed combos', () =>
    expect(
      describeRecurrence({
        kind: 'monthlyWeekday',
        combos: [
          { week: 1, weekday: 1 },
          { week: -1, weekday: 5 },
        ],
      }),
    ).toBe('First Monday & Last Friday of the month'));
  it('yearly', () =>
    expect(describeRecurrence({ kind: 'yearly', dates: [{ month: 4, day: 15 }] })).toBe(
      'Every year on Apr 15',
    ));
  it('yearly multi-date', () =>
    expect(
      describeRecurrence({
        kind: 'yearly',
        dates: [
          { month: 1, day: 1 },
          { month: 7, day: 1 },
        ],
      }),
    ).toBe('Every year on Jan 1 & Jul 1'));
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
    expect(
      describeRecurrence({
        kind: 'weekly',
        weekdays: [1],
        interval: 1,
        activeMonths: [3, 6, 9, 12],
      }),
    ).toBe('Every Mon (Mar, Jun, Sep, Dec)'));
  it('wrap-around season suffix (Nov–Feb)', () =>
    expect(
      describeRecurrence({
        kind: 'monthly',
        days: [1],
        last: false,
        activeMonths: [11, 12, 1, 2],
      }),
    ).toBe('Monthly on the 1st (Nov–Feb)'));
  it('single-month season suffix', () =>
    expect(describeRecurrence({ kind: 'monthly', days: [1], last: false, activeMonths: [7] })).toBe(
      'Monthly on the 1st (Jul)',
    ));
});
