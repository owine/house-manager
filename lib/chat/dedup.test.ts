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

  // The boundary the threshold actually guards: a POSITIVE score that is still
  // too low to be a duplicate. The zero-score case above passes with or without
  // the threshold, because `score > bestScore` already rejects it.
  // 'Lightbulbs' vs 'Bulb types' scores ~0.353 — see lib/chat/dice.test.ts.
  it('returns null for a positive score below the threshold', () => {
    expect(findDuplicateNote('Bulb types', [{ id: 'n1', title: 'Lightbulbs' }])).toBeNull();
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
