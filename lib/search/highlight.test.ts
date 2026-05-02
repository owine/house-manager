import { describe, expect, it } from 'vitest';
import { HL_CLOSE, HL_OPEN, safeHighlight } from './highlight';

describe('safeHighlight', () => {
  it('returns plain text unchanged when there are no sentinels', () => {
    expect(safeHighlight('hello world')).toBe('hello world');
  });

  it('replaces sentinels with em tags', () => {
    const input = `the ${HL_OPEN}furnace${HL_CLOSE} broke`;
    expect(safeHighlight(input)).toBe('the <em>furnace</em> broke');
  });

  it('handles multiple matches', () => {
    const input = `${HL_OPEN}a${HL_CLOSE} and ${HL_OPEN}b${HL_CLOSE}`;
    expect(safeHighlight(input)).toBe('<em>a</em> and <em>b</em>');
  });

  it('escapes HTML characters before replacing sentinels (XSS safety)', () => {
    const input = `<script>alert(1)</script> and ${HL_OPEN}safe${HL_CLOSE}`;
    expect(safeHighlight(input)).toBe('&lt;script&gt;alert(1)&lt;/script&gt; and <em>safe</em>');
  });

  it('escapes ampersands and quotes', () => {
    expect(safeHighlight(`Tom & "Jerry"`)).toBe('Tom &amp; &quot;Jerry&quot;');
  });

  it('survives a sentinel adjacent to special chars', () => {
    const input = `${HL_OPEN}<script>${HL_CLOSE}`;
    // <script> inside the highlighted match must still be escaped
    expect(safeHighlight(input)).toBe('<em>&lt;script&gt;</em>');
  });
});
