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
