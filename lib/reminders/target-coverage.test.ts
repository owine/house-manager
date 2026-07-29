import { describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { type CoverageFacts, dropSystemCoveredItems } from './target-coverage';

const JUN1 = asCalendarDate(new Date('2026-06-01T00:00:00Z'));
const JUN8 = asCalendarDate(new Date('2026-06-08T00:00:00Z'));

/** A minimal row shape standing in for the three real ones. */
type Row = { name: string } & CoverageFacts;

const facts = (r: Row): CoverageFacts => ({
  systemId: r.systemId,
  itemSystemId: r.itemSystemId,
  dueOn: r.dueOn,
});

const names = (rows: Row[]) => dropSystemCoveredItems(rows, facts).map((r) => r.name);

describe('dropSystemCoveredItems', () => {
  it('returns an empty array for no targets', () => {
    expect(dropSystemCoveredItems([], facts)).toEqual([]);
  });

  it('hides an item whose parent system is also targeted', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
      ]),
    ).toEqual(['HVAC']);
  });

  it('keeps an item whose parent system is NOT targeted', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'Plumbing', systemId: 'plumb', itemSystemId: null },
      ]),
    ).toEqual(['Furnace', 'Plumbing']);
  });

  it('keeps an unassigned item (no parent system at all)', () => {
    expect(
      names([
        { name: 'Fridge', systemId: null, itemSystemId: null },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
      ]),
    ).toEqual(['Fridge', 'HVAC']);
  });

  it('never hides a system target', () => {
    expect(
      names([
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
        { name: 'HVAC again', systemId: 'hvac', itemSystemId: null },
      ]),
    ).toEqual(['HVAC', 'HVAC again']);
  });

  it('keeps a covered item when the due dates disagree', () => {
    // The furnace filter drifted a week past its system's date. Hiding it
    // would make an actionable target invisible until the system came due.
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac', dueOn: JUN8 },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null, dueOn: JUN1 },
      ]),
    ).toEqual(['Furnace', 'HVAC']);
  });

  it('hides a covered item when the due dates match', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac', dueOn: JUN1 },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null, dueOn: JUN1 },
      ]),
    ).toEqual(['HVAC']);
  });

  it('treats an omitted dueOn as agreeing (the TargetsChips call shape)', () => {
    expect(
      names([
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null, dueOn: JUN1 },
      ]),
    ).toEqual(['HVAC']);
  });

  it('preserves input order among survivors', () => {
    expect(
      names([
        { name: 'Fridge', systemId: null, itemSystemId: null },
        { name: 'Furnace', systemId: null, itemSystemId: 'hvac' },
        { name: 'HVAC', systemId: 'hvac', itemSystemId: null },
        { name: 'Attic Fan', systemId: null, itemSystemId: null },
      ]),
    ).toEqual(['Fridge', 'HVAC', 'Attic Fan']);
  });
});
