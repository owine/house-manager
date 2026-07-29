import { describe, expect, it } from 'vitest';
import { collapseDuplicateReminderEvents } from './collapse';

const AUG1 = new Date('2026-08-01T00:00:00Z');
const AUG2 = new Date('2026-08-02T00:00:00Z');

const ev = (kind: string, id: string, date: Date) => ({ kind, id, date });

describe('collapseDuplicateReminderEvents', () => {
  it('returns an empty array for no events', () => {
    expect(collapseDuplicateReminderEvents([])).toEqual([]);
  });

  it('collapses one reminder appearing once per target on the same day', () => {
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the same reminder on two different days', () => {
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG2),
    ]);
    expect(out.map((e) => e.date)).toEqual([AUG1, AUG2]);
  });

  it('keeps distinct reminders on the same day', () => {
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_gutters', AUG1),
    ]);
    expect(out.map((e) => e.id)).toEqual(['rem_hvac', 'rem_gutters']);
  });

  it('does not let a service record collide with a reminder sharing its id', () => {
    // Distinct id spaces in practice; keyed on `kind` so that stays structural.
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'shared_id', AUG1),
      ev('service', 'shared_id', AUG1),
    ]);
    expect(out).toHaveLength(2);
  });

  it('is keep-first and order-preserving', () => {
    const first = ev('reminder', 'rem_hvac', AUG1);
    const out = collapseDuplicateReminderEvents([
      first,
      ev('service', 'svc_1', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(first);
  });

  it('treats two distinct Date objects for the same day as duplicates', () => {
    // Date identity must not leak into the key — same day, different instances.
    const out = collapseDuplicateReminderEvents([
      ev('reminder', 'rem_hvac', new Date('2026-08-01T00:00:00Z')),
      ev('reminder', 'rem_hvac', new Date('2026-08-01T00:00:00Z')),
    ]);
    expect(out).toHaveLength(1);
  });
});
