import { describe, expect, it } from 'vitest';
import { deriveSessionTitle } from './title';

describe('deriveSessionTitle', () => {
  it('uses a normal first line as-is', () => {
    expect(deriveSessionTitle('I reset the water heater on the 3rd')).toBe(
      'I reset the water heater on the 3rd',
    );
  });

  it('takes the first NON-empty line when the first line is blank', () => {
    expect(deriveSessionTitle('\n\nHere are the bulbs in each room')).toBe(
      'Here are the bulbs in each room',
    );
  });

  it('cuts a line over 80 chars on a word boundary and adds an ellipsis', () => {
    const line =
      'This is a very long first message describing everything that happened this week around the house';
    const title = deriveSessionTitle(line);
    expect(title.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('  ');
    expect(line.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('falls back to a hard cut for a long blob with no usable space', () => {
    const blob = 'x'.repeat(8000);
    const title = deriveSessionTitle(blob);
    expect(title.length).toBeGreaterThan(0);
    expect(title.endsWith('…')).toBe(true);
    // No space anywhere, so the cut is a hard 80-char slice, not empty.
    expect(title.replace('…', '').length).toBe(80);
  });

  it('yields Untitled for an all-whitespace turn', () => {
    expect(deriveSessionTitle('   \n  \n\t')).toBe('Untitled');
  });
});
