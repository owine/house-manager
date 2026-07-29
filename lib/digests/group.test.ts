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
  // item AND the system that owns it. Under the "HVAC" heading, "Furnace" adds
  // nothing the heading has not already said — the system covers its items.
  it('drops both the self-referential system target and the items it covers', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'system', id: HVAC.id, name: HVAC.name }, system: HVAC }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.system?.name).toBe('HVAC');
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.title).toBe('Replace filter');
    expect(groups[0]?.entries[0]?.targets).toEqual([]);
  });

  it('keeps items when the entry carries no system target of its own', () => {
    // Nothing covers them: the heading is attribution, not a target.
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' }, system: HVAC }),
      row({ target: { kind: 'item', id: 'itm_hp', name: 'Heat Pump' }, system: HVAC }),
    ]);

    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Furnace', 'Heat Pump']);
  });

  it('keeps a covered item whose due date drifted from its system target', () => {
    // Different dueOn => different entry => no system target in scope to cover
    // it. The date rule holds here without any date comparison.
    const groups = groupBySystem([
      row({ dueOn: JUN5, target: { kind: 'item', id: 'itm_furnace', name: 'Furnace' } }),
      row({ dueOn: JUN1, target: { kind: 'system', id: HVAC.id, name: HVAC.name } }),
    ]);

    expect(groups[0]?.entries).toHaveLength(2);
    const jun5 = groups[0]?.entries.find((e) => e.dueOn.getTime() === JUN5.getTime());
    expect(jun5?.targets.map((t) => t.name)).toEqual(['Furnace']);
    const jun1 = groups[0]?.entries.find((e) => e.dueOn.getTime() === JUN1.getTime());
    expect(jun1?.targets).toEqual([]);
  });

  it('leaves the Unassigned group alone', () => {
    // system === null, so no item there has a parent that could cover it.
    const groups = groupBySystem([
      row({ system: null, target: { kind: 'item', id: 'itm_fridge', name: 'Fridge' } }),
    ]);

    expect(groups[0]?.system).toBeNull();
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual(['Fridge']);
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

  it('sorts targets by name regardless of input order', () => {
    const groups = groupBySystem([
      row({ target: { kind: 'item', id: 'z', name: 'Zone Valve' } }),
      row({ target: { kind: 'item', id: 'a', name: 'Air Handler' } }),
      row({ target: { kind: 'item', id: 'm', name: 'Manifold' } }),
    ]);
    expect(groups[0]?.entries[0]?.targets.map((t) => t.name)).toEqual([
      'Air Handler',
      'Manifold',
      'Zone Valve',
    ]);
  });

  it('sorts entries by due date regardless of input order', () => {
    const groups = groupBySystem([
      row({ dueOn: JUN5, daysOverdue: 1, target: { kind: 'item', id: 'b', name: 'Attic' } }),
      row({ dueOn: JUN1, daysOverdue: 3, target: { kind: 'item', id: 'a', name: 'Furnace' } }),
    ]);
    expect(groups[0]?.entries.map((e) => e.daysOverdue)).toEqual([3, 1]);
  });

  it('breaks a system-name tie on id so ordering is deterministic', () => {
    // System.name has no uniqueness constraint, so two systems can share a name.
    const B = { id: 'sys_b', name: 'Boiler' };
    const A = { id: 'sys_a', name: 'Boiler' };
    const groups = groupBySystem([
      row({ system: B, target: { kind: 'item', id: '1', name: 'X' } }),
      row({ system: A, target: { kind: 'item', id: '2', name: 'Y' } }),
    ]);
    expect(groups.map((g) => g.system?.id)).toEqual(['sys_a', 'sys_b']);
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
