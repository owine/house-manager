import { describe, expect, it } from 'vitest';

import { chunkText, estimateTokens, TARGET_TOKENS_PER_CHUNK, TOKEN_CHARS } from './chunk';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up to whole tokens', () => {
    expect(estimateTokens('hello')).toBe(2); // 5 / 4 = 1.25 -> 2
  });
});

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('returns a single chunk for short input', () => {
    const out = chunkText('Hello world');
    expect(out).toEqual(['Hello world']);
  });

  it('paragraph-splits long input into multiple chunks', () => {
    // Build text well over the target by repeating a paragraph.
    const para = 'A '.repeat(50) + 'B '.repeat(50); // ~200 chars
    const longText = Array.from({ length: 30 }, () => para).join('\n\n'); // ~6000 chars

    const chunks = chunkText(longText);

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be approximately at or below the target char budget,
    // accounting for the overlap added at chunk boundaries.
    const targetChars = TARGET_TOKENS_PER_CHUNK * TOKEN_CHARS; // 2000
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(targetChars + 250); // overlap + slack
    }
  });

  it('falls back to mid-text split when a single paragraph is too long', () => {
    const giant = 'x'.repeat(TARGET_TOKENS_PER_CHUNK * TOKEN_CHARS * 3); // 6000 x's
    const chunks = chunkText(giant);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should at least be non-empty and the assembled chunks
    // should cover roughly the same total character count.
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalChars).toBeGreaterThanOrEqual(giant.length);
  });

  it('preserves text across overlap (every chunk after the first starts with a tail of the prior chunk)', () => {
    const para = 'lorem ipsum dolor sit amet '.repeat(50);
    const longText = Array.from({ length: 20 }, () => para).join('\n\n');
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);

    // Tail of chunk[0] should appear at the start of chunk[1] (overlap).
    const overlapChars = 200; // OVERLAP_TOKENS * TOKEN_CHARS
    const [first, second] = chunks;
    if (!first || !second) throw new Error('expected at least two chunks');
    const tail = first.slice(-overlapChars);
    expect(second.startsWith(tail)).toBe(true);
  });
});
