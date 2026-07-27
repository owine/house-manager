import { describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { type DigestRow, groupBySystem } from './group';

const HVAC = { id: 'sys_hvac', name: 'HVAC' };
const PLUMBING = { id: 'sys_plumb', name: 'Plumbing' };

const JUN1 = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
const JUN5 = asCalendarDate(new Date('2026-06-05T00:00:00Z'));

function row(over: Partial<DigestRow> = {}): DigestRow {
  return {
    reminderId: 'rem_1',
    title: 'Replace filter',
    dueOn: JUN1,
    daysOverdue: 3,
    target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' },
    system: HVAC,
    ...over,
  };
}

describe('groupBySystem', () => {
  it('returns an empty array for no rows', () => {
    expect(groupBySystem([])).toEqual([]);
  });

  it('collapses several targets of one reminder into a single entry', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_a', name: 'Air Handler' } }),
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Air Handler', 'Furnace']);
  });

  it('splits one reminder across the systems its targets belong to', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'item', id: 'itm_wh', name: 'Water Heater' }, system: PLUMBING }),
    ]);

    expect(groups.map((g) => g.system?.name)).toEqual(['HVAC', 'Plumbing']);
    // Each heading lists ONLY its own system's targets — no heading ever shows
    // a target belonging to a different system.
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Furnace']);
    expect(groups[1]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Water Heater']);
  });

  it('splits one reminder into separate entries when due dates differ', () => {
    const groups = groupBySystem([
      row({ dueOn: JUN1, daysOverdue: 3, target: { kind: 'item', id: 'a', name: 'Furnace' } }),
      row({ dueOn: JUN5, daysOverdue: 1, target: { kind: 'item', id: 'b', name: 'Attic' } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[0]?.entries.map((e) => e.daysOverdue)).toEqual([3, 1]);
  });

  it('puts rows with no system in an Unassigned group, ordered last', () => {
    const groups = groupBySystem([
      row({ system: null, target: { kind: 'item', id: 'x', name: 'Smoke Alarm' } }),
      row({ system: HVAC }),
    ]);

    expect(groups.map((g) => g.system?.name ?? null)).toEqual(['HVAC', null]);
  });

  it('treats a chore with no target at all as Unassigned', () => {
    const groups = groupBySystem([row({ system: null, target: null })]);
    expect(groups[0]?.system).toBeNull();
    expect(groups[0]?.entries[0]?.targets).toEqual([]);
  });

  it('drops a target that IS the group system, leaving no target line', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'system', id: HVAC.id, name: HVAC.name }, system: HVAC }),
    ]);
    expect(groups[0]?.entries[0]?.targets).toEqual([]);
  });

  // The mixed case targetsArraySchema permits: one reminder targeting both an
  // item AND the system that owns it. A "suppress only when it is the sole
  // target" rule would render "HVAC" as a bullet under the "HVAC" heading.
  it('drops the self-referential system target but keeps the item', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'system', id: HVAC.id, name: HVAC.name }, system: HVAC }),
    ]);

    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Furnace']);
  });

  it('orders systems alphabetically, entries by date then title, targets by name', () => {
    const groups = groupBySystem([
      row({ system: PLUMBING, target: { kind: 'item', id: 'p', name: 'Water Heater' } }),
      row({
        system: HVAC,
        reminderId: 'rem_2',
        title: 'Zebra task',
        dueOn: JUN1,
        target: { kind: 'item', id: 'z', name: 'Zone Valve' },
      }),
      row({
        system: HVAC,
        reminderId: 'rem_3',
        title: 'Apple task',
        dueOn: JUN1,
        target: { kind: 'item', id: 'a2', name: 'Blower' },
      }),
    ]);

    expect(groups.map((g) => g.system?.name)).toEqual(['HVAC', 'Plumbing']);
    expect(groups[0]?.entries.map((e) => e.title)).toEqual(['Apple task', 'Zebra task']);
  });

  it('does not collide two different calendar dates that are equal by value', () => {
    // Two distinct Date objects for the same day must land in the SAME entry.
    // Using the Date object itself as a Map key would make them different keys.
    const a = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
    const b = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
    const groups = groupBySystem([
      row({ dueOn: a, target: { kind: 'item', id: '1', name: 'A' } }),
      row({ dueOn: b, target: { kind: 'item', id: '2', name: 'B' } }),
    ]);
    expect(groups[0]?.entries).toHaveLength(1);
  });
});
