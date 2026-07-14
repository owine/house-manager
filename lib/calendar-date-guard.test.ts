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

describe('nested relation writes', () => {
  // The first version of this guard checked ONLY the top-level model, so a nested
  // write sailed straight through -- and nested is exactly how the app creates
  // reminder targets (lib/reminders/actions.ts, lib/ai/suggest/reminders.ts). The
  // guard protected none of those paths.
  it('catches an instant nested under reminder.create -> targets.create', () => {
    expect(() =>
      assertCalendarDateWrite('Reminder', {
        title: 'x',
        targets: { create: [{ itemId: 'i', nextDueOn: EVENING_IN_CHICAGO }] },
      }),
    ).toThrow(/ReminderTarget\.nextDueOn/);
  });

  it('catches an instant nested under a createMany { data } wrapper', () => {
    expect(() =>
      assertCalendarDateWrite('Reminder', {
        title: 'x',
        targets: { createMany: { data: [{ nextDueOn: EVENING_IN_CHICAGO }] } },
      }),
    ).toThrow(/ReminderTarget\.nextDueOn/);
  });

  it('catches an instant nested under an update { where, data } wrapper', () => {
    expect(() =>
      assertCalendarDateWrite('Reminder', {
        targets: { update: { where: { id: 't' }, data: { nextDueOn: EVENING_IN_CHICAGO } } },
      }),
    ).toThrow(/ReminderTarget\.nextDueOn/);
  });

  it('catches an instant nested under upsert.create', () => {
    expect(() =>
      assertCalendarDateWrite('Reminder', {
        targets: {
          upsert: {
            where: { id: 't' },
            create: { nextDueOn: EVENING_IN_CHICAGO },
            update: {},
          },
        },
      }),
    ).toThrow(/ReminderTarget\.nextDueOn/);
  });

  it('still accepts a valid nested calendar date', () => {
    expect(() =>
      assertCalendarDateWrite('Reminder', {
        title: 'x',
        targets: { create: [{ itemId: 'i', nextDueOn: cal(2026, 7, 14) }] },
      }),
    ).not.toThrow();
  });

  it('does not choke on connect / disconnect payloads', () => {
    expect(() =>
      assertCalendarDateWrite('Reminder', { targets: { connect: [{ id: 't' }] } }),
    ).not.toThrow();
  });
});
