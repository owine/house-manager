import { describe, expect, it } from 'vitest';
import { limitForKind } from './rate-limit';

describe('limitForKind', () => {
  it('gives chat a higher budget than the one-shot kinds', () => {
    expect(limitForKind('chat')).toBe(40);
    expect(limitForKind('ask')).toBe(10);
  });

  // AISuggestionLog.kind is a String column, not an enum, so there is no
  // compile-time exhaustiveness — an unknown kind MUST fall back rather than
  // returning undefined and disabling the limit entirely.
  it('falls back to the default for an unknown kind', () => {
    expect(limitForKind('something-new')).toBe(10);
  });
});
