import { describe, expect, it } from 'vitest';
import { diceSimilarity, NOTE_DEDUP_THRESHOLD } from './dice';

describe('NOTE_DEDUP_THRESHOLD', () => {
  // Every other assertion here is relative to this constant, so a silent change
  // to it would pass the whole suite. Task 10 imports this exact number to
  // decide whether a note is a duplicate — pin the value itself.
  it('is 0.5', () => {
    expect(NOTE_DEDUP_THRESHOLD).toBe(0.5);
  });
});

describe('diceSimilarity', () => {
  it('scores identical titles 1', () => {
    expect(diceSimilarity('Lightbulbs', 'Lightbulbs')).toBe(1);
  });

  it('ignores case, punctuation and whitespace', () => {
    expect(diceSimilarity('Light bulbs', 'lightbulbs')).toBe(1);
    expect(diceSimilarity('Lightbulbs!', 'lightbulbs')).toBe(1);
  });

  it('scores a restatement above the dedup threshold', () => {
    expect(diceSimilarity('Lightbulbs', 'Lightbulbs (2)')).toBeGreaterThan(NOTE_DEDUP_THRESHOLD);
  });

  it('scores unrelated titles near zero', () => {
    expect(diceSimilarity('Lightbulbs', 'Roof warranty')).toBeLessThan(0.2);
  });

  // Documented limitation, asserted so nobody "fixes" the threshold to chase it.
  // Synonym drift is a semantic relationship, not a string one — only the
  // deferred RAG supplement will catch this pair.
  it('does NOT catch synonym drift', () => {
    expect(diceSimilarity('Lightbulbs', 'Bulb types')).toBeLessThan(NOTE_DEDUP_THRESHOLD);
  });

  it('handles strings too short to form a bigram', () => {
    expect(diceSimilarity('a', 'a')).toBe(1);
    expect(diceSimilarity('a', 'b')).toBe(0);
    expect(diceSimilarity('', 'anything')).toBe(0);
  });
});
