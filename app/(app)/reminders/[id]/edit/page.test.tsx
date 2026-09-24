// A reminder with no targets (e.g. its only system was deleted before system
// deletes were guarded) has no derived nextDueOn. The edit page used to fall
// back to `new Date()` — an INSTANT, which the form submits untouched and the
// calendar-date write guard then rejects. The fallback must be today's HOUSE
// day at UTC midnight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getReminder } = vi.hoisted(() => ({ getReminder: vi.fn() }));

vi.mock('@/components/reminders/ReminderForm', () => ({ ReminderForm: () => null }));
vi.mock('@/lib/reminders/actions', () => ({ updateReminder: vi.fn() }));
vi.mock('@/lib/reminders/queries', () => ({ getReminder }));
vi.mock('@/lib/items/queries', () => ({ listAllActiveItemsForPicker: vi.fn(async () => []) }));
vi.mock('@/lib/parts/queries', () => ({ listPartsForPicker: vi.fn(async () => []) }));
vi.mock('@/lib/systems/queries', () => ({
  listSystemsWithItemsForPicker: vi.fn(async () => []),
}));
vi.mock('@/lib/house-profile/queries', () => ({
  getHouseTimezone: vi.fn(async () => 'America/Chicago'),
}));

import EditReminderPage from './page';

function reminder(nextDueOn: Date | null) {
  return {
    id: 'r1',
    title: 'Flush water heater',
    description: null,
    recurrence: { kind: 'interval', every: 30, unit: 'day' },
    nextDueOn,
    leadTimeDays: 3,
    autoCreateServiceRecord: false,
    autoComplete: false,
    kind: 'REMINDER',
    targets: [],
  };
}

async function formDefaults(): Promise<{ nextDueOn: Date }> {
  const el = await EditReminderPage({ params: Promise.resolve({ id: 'r1' }) });
  return el.props.children.props.defaultValues;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 21:00 on Jul 14 in Chicago (CDT, UTC-5) — already Jul 15 in UTC.
  vi.setSystemTime(new Date('2026-07-15T02:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  getReminder.mockReset();
});

describe('EditReminderPage nextDueOn default', () => {
  it("falls back to today's house day at UTC midnight when the reminder has no targets", async () => {
    getReminder.mockResolvedValue(reminder(null));
    expect((await formDefaults()).nextDueOn).toEqual(new Date('2026-07-14T00:00:00.000Z'));
  });

  it("passes the reminder's own due date through unchanged", async () => {
    const due = new Date('2026-08-01T00:00:00.000Z');
    getReminder.mockResolvedValue(reminder(due));
    expect((await formDefaults()).nextDueOn).toEqual(due);
  });
});
