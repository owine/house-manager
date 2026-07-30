import { describe, expect, it } from 'vitest';
import { expandSystemSelection } from '@/lib/targets/expand';

describe('expandSystemSelection', () => {
  it('expands an empty seed with a system having two active items', () => {
    const result = expandSystemSelection([], {
      id: 'sys1',
      items: [
        { id: 'a', archivedAt: null },
        { id: 'b', archivedAt: null },
      ],
    });
    expect(result).toEqual([{ systemId: 'sys1' }, { itemId: 'a' }, { itemId: 'b' }]);
  });

  it('does not duplicate the system row when seed already contains it', () => {
    const result = expandSystemSelection([{ systemId: 'sys1' }], {
      id: 'sys1',
      items: [{ id: 'a', archivedAt: null }],
    });
    expect(result).toEqual([{ systemId: 'sys1' }, { itemId: 'a' }]);
  });

  it('does not duplicate items already in the seed', () => {
    const result = expandSystemSelection([{ itemId: 'a' }], {
      id: 'sys1',
      items: [
        { id: 'a', archivedAt: null },
        { id: 'b', archivedAt: null },
      ],
    });
    expect(result).toEqual([{ itemId: 'a' }, { systemId: 'sys1' }, { itemId: 'b' }]);
  });

  it('excludes archived components', () => {
    const result = expandSystemSelection([], {
      id: 'sys1',
      items: [
        { id: 'a', archivedAt: null },
        { id: 'b', archivedAt: new Date('2026-01-01') },
        { id: 'c', archivedAt: null },
      ],
    });
    expect(result).toEqual([{ systemId: 'sys1' }, { itemId: 'a' }, { itemId: 'c' }]);
  });

  it('returns just the system when it has no items', () => {
    const result = expandSystemSelection([], { id: 'sys1', items: [] });
    expect(result).toEqual([{ systemId: 'sys1' }]);
  });

  // A guard, NOT a regression test — be honest about which. The two-column key
  // builder this replaced could not actually lose a part row: `out` starts as
  // `[...seed]`, so seed entries are kept regardless of their key, and the Set
  // only gates what gets *appended*. `s:undefined` never equals a real
  // `s:<id>`, so nothing collided.
  //
  // The three-way `keyOf` matters if a future change ever appends part rows
  // (e.g. expanding a system to its parts — deliberately not done, see the
  // note in expand.ts). This test pins the behaviour so that change can't
  // silently dedupe them together.
  it('keeps two distinct part targets in the seed', () => {
    const out = expandSystemSelection([{ partId: 'p1' }, { partId: 'p2' }], {
      id: 's1',
      items: [{ id: 'i1', archivedAt: null }],
    });
    expect(out).toContainEqual({ partId: 'p1' });
    expect(out).toContainEqual({ partId: 'p2' });
    expect(out).toContainEqual({ systemId: 's1' });
    expect(out).toContainEqual({ itemId: 'i1' });
  });

  it('preserves seed order and appends new entries', () => {
    const result = expandSystemSelection([{ itemId: 'pre1' }, { systemId: 'other' }], {
      id: 'sys1',
      items: [
        { id: 'pre1', archivedAt: null },
        { id: 'new1', archivedAt: null },
      ],
    });
    expect(result).toEqual([
      { itemId: 'pre1' },
      { systemId: 'other' },
      { systemId: 'sys1' },
      { itemId: 'new1' },
    ]);
  });
});
