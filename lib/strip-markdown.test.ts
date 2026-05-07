import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './strip-markdown';

describe('stripMarkdown', () => {
  it('returns empty string unchanged', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('strips bold **text**', () => {
    expect(stripMarkdown('**Master** - 091017')).toBe('Master - 091017');
  });

  it('strips bold __text__', () => {
    expect(stripMarkdown('__important__ note')).toBe('important note');
  });

  it('strips italic *text* without eating mid-word asterisks', () => {
    expect(stripMarkdown('an *italic* word')).toBe('an italic word');
    expect(stripMarkdown('5 * 4 = 20')).toBe('5 * 4 = 20');
  });

  it('strips italic next to non-ASCII punctuation', () => {
    expect(stripMarkdown('«*hello*»')).toBe('«hello»');
    expect(stripMarkdown('an em-dash—*emphasis*—example')).toBe('an em-dash—emphasis—example');
  });

  it('strips italic _text_ without eating snake_case', () => {
    expect(stripMarkdown('a _emphasized_ thing')).toBe('a emphasized thing');
    expect(stripMarkdown('use the_function name')).toBe('use the_function name');
  });

  it('strips inline code', () => {
    expect(stripMarkdown('run `npm install` first')).toBe('run npm install first');
  });

  it('strips headings', () => {
    expect(stripMarkdown('# Title\n## Sub\n### Sub-sub')).toBe('Title\nSub\nSub-sub');
  });

  it('strips list markers', () => {
    expect(stripMarkdown('- item 1\n- item 2')).toBe('item 1\nitem 2');
    expect(stripMarkdown('* item 1\n+ item 2')).toBe('item 1\nitem 2');
    expect(stripMarkdown('1. first\n2. second')).toBe('first\nsecond');
  });

  it('strips blockquotes', () => {
    expect(stripMarkdown('> a quote\n> on two lines')).toBe('a quote\non two lines');
  });

  it('preserves link text and drops URLs', () => {
    expect(stripMarkdown('See [the docs](https://example.com)')).toBe('See the docs');
  });

  it('preserves image alt text', () => {
    expect(stripMarkdown('![alt text](https://example.com/img.png)')).toBe('alt text');
  });

  it('collapses 3+ blank lines to one blank line', () => {
    expect(stripMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('handles a multi-section note with bold headers, plain rows, and blank-line paragraph breaks', () => {
    const input = `**Section A** - aaaa

**Section B**
row one - 1
row two - 2
row three - 3

**Section C**
final row`;
    const expected = `Section A - aaaa

Section B
row one - 1
row two - 2
row three - 3

Section C
final row`;
    expect(stripMarkdown(input)).toBe(expected);
  });
});
