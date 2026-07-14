import { describe, expect, it } from 'vitest';
import { assertCalendarDateWrite } from './calendar-date-guard';

const cal = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const EVENING_IN_CHICAGO = new Date('2026-07-15T01:00:00Z'); // 20:00 CDT Jul 14
const CHORE_STAMP = new Date('2026-07-15T04:59:59.999Z'); // endOfCalendarDayInTz

describe('assertCalendarDateWrite', () => {
  it('accepts a UTC-midnight calendar date', () => {
    expect(() =>
      assertCalendarDateWrite('ServiceRecord', { performedOn: cal(2026, 7, 14) }),
    ).not.toThrow();
  });

  it('rejects an instant written to a calendar-date column', () => {
    // Postgres would store this as its UTC day -- Jul 15 -- which is the WRONG day.
    // The user completed it on Jul 14 in Chicago.
    expect(() =>
      assertCalendarDateWrite('ServiceRecord', { performedOn: EVENING_IN_CHICAGO }),
    ).toThrow(/calendar date .* time component/i);
  });

  it('rejects the chore auto-complete sentinel instant', () => {
    expect(() => assertCalendarDateWrite('ReminderTarget', { nextDueOn: CHORE_STAMP })).toThrow(
      /startOfDayUtc/,
    );
  });

  it('names the offending model and field', () => {
    expect(() => assertCalendarDateWrite('Warranty', { endsOn: EVENING_IN_CHICAGO })).toThrow(
      /Warranty\.endsOn/,
    );
  });

  it('walks createMany arrays', () => {
    expect(() =>
      assertCalendarDateWrite('ReminderTarget', [
        { nextDueOn: cal(2026, 7, 14) },
        { nextDueOn: EVENING_IN_CHICAGO }, // the bad one, second
      ]),
    ).toThrow(/ReminderTarget\.nextDueOn/);
  });

  it('unwraps the { set: ... } update-operation form', () => {
    expect(() =>
      assertCalendarDateWrite('ReminderTarget', { nextDueOn: { set: EVENING_IN_CHICAGO } }),
    ).toThrow(/nextDueOn/);
    expect(() =>
      assertCalendarDateWrite('ReminderTarget', { nextDueOn: { set: cal(2026, 7, 14) } }),
    ).not.toThrow();
  });

  it('ignores instant columns on the same model', () => {
    // `completedOn` / `lastCompletedOn` are genuinely instants -- they must NOT be
    // caught by this guard.
    expect(() =>
      assertCalendarDateWrite('ReminderTarget', {
        nextDueOn: cal(2026, 7, 14),
        lastCompletedOn: EVENING_IN_CHICAGO,
      }),
    ).not.toThrow();
  });

  it('ignores models with no calendar-date columns, and null/undefined payloads', () => {
    expect(() => assertCalendarDateWrite('User', { createdAt: EVENING_IN_CHICAGO })).not.toThrow();
    expect(() => assertCalendarDateWrite('ServiceRecord', null)).not.toThrow();
    expect(() =>
      assertCalendarDateWrite(undefined, { performedOn: EVENING_IN_CHICAGO }),
    ).not.toThrow();
  });

  it('accepts null for a nullable calendar-date column', () => {
    expect(() => assertCalendarDateWrite('Item', { purchaseDate: null })).not.toThrow();
  });
});
