import { describe, expect, it } from 'vitest';
import { collapseDuplicateEvents } from './collapse';
import type { CalendarEvent } from './queries';

const AUG1 = new Date('2026-08-01T00:00:00Z');
const AUG2 = new Date('2026-08-02T00:00:00Z');

const ev = (kind: CalendarEvent['kind'], id: string, date: Date): CalendarEvent => ({
  kind,
  id,
  title: id,
  date,
});

describe('collapseDuplicateEvents', () => {
  it('returns an empty array for no events', () => {
    expect(collapseDuplicateEvents([])).toEqual([]);
  });

  it('collapses one reminder appearing once per target on the same day', () => {
    const out = collapseDuplicateEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps the same reminder on two different days', () => {
    const out = collapseDuplicateEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_hvac', AUG2),
    ]);
    expect(out.map((e) => e.date)).toEqual([AUG1, AUG2]);
  });

  it('keeps distinct reminders on the same day', () => {
    const out = collapseDuplicateEvents([
      ev('reminder', 'rem_hvac', AUG1),
      ev('reminder', 'rem_gutters', AUG1),
    ]);
    expect(out.map((e) => e.id)).toEqual(['rem_hvac', 'rem_gutters']);
  });

  it('does not let a service record collide with a reminder sharing its id', () => {
    // Distinct id spaces in practice; keyed on `kind` so that stays structural.
    const out = collapseDuplicateEvents([
      ev('reminder', 'shared_id', AUG1),
      ev('service', 'shared_id', AUG1),
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses duplicate service events on the same day', () => {
    const out = collapseDuplicateEvents([
      ev('service', 'svc_1', AUG1),
      ev('service', 'svc_1', AUG1),
    ]);
    expect(out).toHaveLength(1);
  });

  it('is keep-first and order-preserving', () => {
    const first = ev('reminder', 'rem_hvac', AUG1);
    const out = collapseDuplicateEvents([
      first,
      ev('service', 'svc_1', AUG1),
      ev('reminder', 'rem_hvac', AUG1),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(first);
  });

  it('treats two distinct Date objects for the same day as duplicates', () => {
    // Date identity must not leak into the key — same day, different instances.
    const out = collapseDuplicateEvents([
      ev('reminder', 'rem_hvac', new Date('2026-08-01T00:00:00Z')),
      ev('reminder', 'rem_hvac', new Date('2026-08-01T00:00:00Z')),
    ]);
    expect(out).toHaveLength(1);
  });
});
