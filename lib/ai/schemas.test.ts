import { describe, expect, it } from 'vitest';
import {
  proposeChecklistResponseSchema,
  proposedChecklistItemSchema,
  proposedReminderSchema,
  proposeRemindersResponseSchema,
  recurrenceSchema,
} from './schemas';

describe('recurrenceSchema', () => {
  it.each([
    { kind: 'interval', days: 30 },
    { kind: 'monthly', dayOfMonth: 15 },
    { kind: 'yearly', month: 4, day: 15 },
  ])('accepts %o', (input) => {
    expect(recurrenceSchema.parse(input)).toEqual(input);
  });

  it('rejects unknown kind', () => {
    expect(() => recurrenceSchema.parse({ kind: 'rrule', rrule: 'FREQ=DAILY' })).toThrow();
  });

  it('rejects out-of-range monthly day', () => {
    expect(() => recurrenceSchema.parse({ kind: 'monthly', dayOfMonth: 32 })).toThrow();
  });

  it('rejects negative interval', () => {
    expect(() => recurrenceSchema.parse({ kind: 'interval', days: 0 })).toThrow();
  });
});

describe('proposedReminderSchema', () => {
  it('accepts a valid reminder', () => {
    const r = proposedReminderSchema.parse({
      title: 'Replace HEPA filter',
      description: 'Manufacturer recommends every 90 days.',
      recurrence: { kind: 'interval', days: 90 },
      leadTimeDays: 7,
      rationale: 'Carrier 58STA spec sheet.',
    });
    expect(r.title).toBe('Replace HEPA filter');
    expect(r.leadTimeDays).toBe(7);
  });

  it('defaults leadTimeDays to 3', () => {
    const r = proposedReminderSchema.parse({
      title: 'Replace HEPA filter',
      recurrence: { kind: 'interval', days: 90 },
      rationale: 'spec',
    });
    expect(r.leadTimeDays).toBe(3);
  });

  it('rejects title under 3 chars', () => {
    expect(() =>
      proposedReminderSchema.parse({
        title: 'no',
        recurrence: { kind: 'interval', days: 90 },
        rationale: 'r',
      }),
    ).toThrow();
  });

  it('rejects rationale over 200 chars', () => {
    expect(() =>
      proposedReminderSchema.parse({
        title: 'OK',
        recurrence: { kind: 'interval', days: 90 },
        rationale: 'x'.repeat(201),
      }),
    ).toThrow();
  });

  it('forbids itemId — that is set server-side', () => {
    const r = proposedReminderSchema.parse({
      title: 'OKK',
      recurrence: { kind: 'interval', days: 90 },
      rationale: 'r',
      itemId: 'cuid-leak',
    });
    expect((r as Record<string, unknown>).itemId).toBeUndefined();
  });
});

describe('proposeRemindersResponseSchema', () => {
  it('accepts up to 10 proposals', () => {
    const proposals = Array.from({ length: 10 }, (_, i) => ({
      title: `Reminder ${i}`,
      recurrence: { kind: 'interval' as const, days: 30 },
      rationale: 'r',
    }));
    expect(proposeRemindersResponseSchema.parse({ proposals })).toBeTruthy();
  });

  it('rejects 11+ proposals', () => {
    const proposals = Array.from({ length: 11 }, (_, i) => ({
      title: `Reminder ${i}`,
      recurrence: { kind: 'interval' as const, days: 30 },
      rationale: 'r',
    }));
    expect(() => proposeRemindersResponseSchema.parse({ proposals })).toThrow();
  });

  it('accepts empty proposals (no-suggestion case)', () => {
    expect(proposeRemindersResponseSchema.parse({ proposals: [] }).proposals).toHaveLength(0);
  });
});

describe('proposedChecklistItemSchema', () => {
  it('accepts itemId or null', () => {
    expect(
      proposedChecklistItemSchema.parse({ title: 'Test sump pump', itemId: null, rationale: 'r' }),
    ).toBeTruthy();
    expect(
      proposedChecklistItemSchema.parse({
        title: 'Test sump pump',
        itemId: 'cuid-abc',
        rationale: 'r',
      }),
    ).toBeTruthy();
  });
});

describe('proposeChecklistResponseSchema', () => {
  it('requires at least one item', () => {
    expect(() => proposeChecklistResponseSchema.parse({ name: 'Spring', items: [] })).toThrow();
  });

  it('caps items at 20', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      title: `Item ${i}`,
      itemId: null,
      rationale: 'r',
    }));
    expect(() => proposeChecklistResponseSchema.parse({ name: 'Spring', items })).toThrow();
  });
});
