import { describe, expect, it } from 'vitest';
import { createReminderSchema, recurrenceSchema, updateReminderSchema } from './schema';

describe('recurrenceSchema', () => {
  it.each([
    [{ kind: 'interval', days: 60 }, true],
    [{ kind: 'interval', days: 0 }, false],
    [{ kind: 'interval', days: 3651 }, false],
    [{ kind: 'monthly', dayOfMonth: 15 }, true],
    [{ kind: 'monthly', dayOfMonth: 0 }, false],
    [{ kind: 'monthly', dayOfMonth: 29 }, false],
    [{ kind: 'yearly', month: 3, day: 15 }, true],
    [{ kind: 'yearly', month: 0, day: 15 }, false],
    [{ kind: 'yearly', month: 13, day: 15 }, false],
    [{ kind: 'yearly', month: 3, day: 29 }, false],
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
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
      leadTimeDays: 3,
      autoCreateServiceRecord: false,
    });
    expect(r.success).toBe(true);
  });

  it('accepts a reminder with multiple targets (item + system)', () => {
    const r = createReminderSchema.safeParse({
      title: 'HVAC service',
      targets: [{ itemId: 'cuid-1' }, { systemId: 'cuid-sys-1' }],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing title', () => {
    const r = createReminderSchema.safeParse({
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty targets array', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects target with both itemId and systemId set', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'i', systemId: 's' }],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects target with neither itemId nor systemId set', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{}],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative leadTimeDays', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
      leadTimeDays: -1,
    });
    expect(r.success).toBe(false);
  });

  it('defaults kind to REMINDER when omitted', () => {
    const r = createReminderSchema.safeParse({
      title: 'X',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('REMINDER');
  });

  it('accepts kind=CHORE', () => {
    const r = createReminderSchema.safeParse({
      title: 'Take out trash',
      targets: [{ itemId: 'cuid-1' }],
      recurrence: { kind: 'interval', days: 7 },
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
      recurrence: { kind: 'interval', days: 60 },
      nextDueOn: new Date(),
      kind: 'TASK',
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
});
