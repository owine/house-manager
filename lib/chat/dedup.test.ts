import { describe, expect, it } from 'vitest';
import { findDuplicateNote } from './dedup';

const existing = [
  { id: 'note-1', title: 'Lightbulbs' },
  { id: 'note-2', title: 'Roof warranty' },
];

describe('findDuplicateNote', () => {
  it('matches a restatement of an existing title', () => {
    expect(findDuplicateNote('Light bulbs', existing)?.id).toBe('note-1');
  });

  it('returns null when nothing is similar enough', () => {
    expect(findDuplicateNote('Furnace filter sizes', existing)).toBeNull();
  });

  it('returns the highest-scoring match when several pass', () => {
    const many = [
      { id: 'a', title: 'Lightbulb' },
      { id: 'b', title: 'Lightbulbs' },
    ];
    expect(findDuplicateNote('Lightbulbs', many)?.id).toBe('b');
  });

  it('handles an empty corpus', () => {
    expect(findDuplicateNote('Anything', [])).toBeNull();
  });
});
