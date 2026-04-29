import { describe, expect, it } from 'vitest';
import { createNoteSchema, updateNoteSchema } from '@/lib/notes/schema';

describe('createNoteSchema', () => {
  it('accepts a minimal note with only required fields', () => {
    const result = createNoteSchema.safeParse({
      title: 'My note',
      body: 'Some content',
    });
    expect(result.success).toBe(true);
  });

  it('defaults tags to empty array when omitted', () => {
    const result = createNoteSchema.safeParse({ title: 'T', body: 'B' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tags).toEqual([]);
  });

  it('accepts a note with itemId and tags', () => {
    const result = createNoteSchema.safeParse({
      title: 'Attached note',
      body: '## Markdown body',
      itemId: 'item-abc',
      tags: ['urgent', 'maintenance'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = createNoteSchema.safeParse({ body: 'Body text' });
    expect(result.success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = createNoteSchema.safeParse({ title: '', body: 'Body' });
    expect(result.success).toBe(false);
  });

  it('rejects title exceeding 200 characters', () => {
    const result = createNoteSchema.safeParse({ title: 'x'.repeat(201), body: 'Body' });
    expect(result.success).toBe(false);
  });

  it('accepts title of exactly 200 characters', () => {
    const result = createNoteSchema.safeParse({ title: 'x'.repeat(200), body: 'Body' });
    expect(result.success).toBe(true);
  });

  it('rejects missing body', () => {
    const result = createNoteSchema.safeParse({ title: 'Title' });
    expect(result.success).toBe(false);
  });

  it('rejects empty body', () => {
    const result = createNoteSchema.safeParse({ title: 'Title', body: '' });
    expect(result.success).toBe(false);
  });

  it('rejects body exceeding 20000 characters', () => {
    const result = createNoteSchema.safeParse({ title: 'T', body: 'x'.repeat(20_001) });
    expect(result.success).toBe(false);
  });

  it('accepts body of exactly 20000 characters', () => {
    const result = createNoteSchema.safeParse({ title: 'T', body: 'x'.repeat(20_000) });
    expect(result.success).toBe(true);
  });

  it('rejects itemId as empty string (min 1 when provided)', () => {
    const result = createNoteSchema.safeParse({ title: 'T', body: 'B', itemId: '' });
    expect(result.success).toBe(false);
  });

  it('itemId is undefined when omitted', () => {
    const result = createNoteSchema.safeParse({ title: 'T', body: 'B' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.itemId).toBeUndefined();
  });
});

describe('updateNoteSchema', () => {
  it('requires id', () => {
    const result = updateNoteSchema.safeParse({ title: 'Updated title' });
    expect(result.success).toBe(false);
  });

  it('accepts id with no other fields (full partial)', () => {
    const result = updateNoteSchema.safeParse({ id: 'note-123' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid partial update with id', () => {
    const result = updateNoteSchema.safeParse({
      id: 'note-123',
      title: 'Revised title',
      tags: ['new-tag'],
    });
    expect(result.success).toBe(true);
  });
});
