import { describe, expect, it } from 'vitest';
import type { SuggestionKind } from './log';
import { limitForKind } from './rate-limit';

describe('limitForKind', () => {
  it('gives chat a higher budget than the one-shot kinds', () => {
    expect(limitForKind('chat')).toBe(40);
    expect(limitForKind('ask')).toBe(10);
  });

  // AISuggestionLog.kind is a String column, not an enum, so unknown values
  // are reachable at runtime even though `SuggestionKind` makes them
  // unreachable at compile time — hence the cast here. The fallback MUST
  // still hold rather than returning undefined and disabling the limit
  // entirely.
  it('falls back to the default for an unknown kind', () => {
    expect(limitForKind('something-new' as SuggestionKind)).toBe(10);
  });
});
