import { describe, expect, it } from 'vitest';
import {
  addChecklistItemSchema,
  createChecklistSchema,
  reorderChecklistItemsSchema,
  updateChecklistSchema,
} from '@/lib/checklists/schema';

describe('createChecklistSchema', () => {
  it('accepts a valid name', () => {
    const result = createChecklistSchema.safeParse({ name: 'Spring Prep' });
    expect(result.success).toBe(true);
  });

  it('accepts name + description', () => {
    const result = createChecklistSchema.safeParse({
      name: 'Spring Prep',
      description: 'Things to do in spring',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = createChecklistSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects name longer than 80 characters', () => {
    const result = createChecklistSchema.safeParse({ name: 'a'.repeat(81) });
    expect(result.success).toBe(false);
  });

  it('rejects description longer than 2000 characters', () => {
    const result = createChecklistSchema.safeParse({
      name: 'Valid',
      description: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('updateChecklistSchema', () => {
  it('accepts partial input with only id', () => {
    const result = updateChecklistSchema.safeParse({ id: 'abc123' });
    expect(result.success).toBe(true);
  });

  it('accepts all fields', () => {
    const result = updateChecklistSchema.safeParse({
      id: 'abc123',
      name: 'Updated Name',
      description: 'new desc',
      active: false,
    });
    expect(result.success).toBe(true);
  });

  it('allows description: null to clear it', () => {
    const result = updateChecklistSchema.safeParse({ id: 'abc123', description: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBeNull();
  });

  it('rejects missing id', () => {
    const result = updateChecklistSchema.safeParse({ name: 'No ID' });
    expect(result.success).toBe(false);
  });
});

describe('addChecklistItemSchema', () => {
  it('accepts valid checklistId + title', () => {
    const result = addChecklistItemSchema.safeParse({
      checklistId: 'cl1',
      title: 'Check gutters',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional itemId', () => {
    const result = addChecklistItemSchema.safeParse({
      checklistId: 'cl1',
      title: 'Check gutters',
      itemId: 'item-abc',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.itemId).toBe('item-abc');
  });

  it('rejects empty title', () => {
    const result = addChecklistItemSchema.safeParse({ checklistId: 'cl1', title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing checklistId', () => {
    const result = addChecklistItemSchema.safeParse({ title: 'Check gutters' });
    expect(result.success).toBe(false);
  });
});

describe('reorderChecklistItemsSchema', () => {
  it('accepts non-empty orderedItemIds', () => {
    const result = reorderChecklistItemsSchema.safeParse({
      checklistId: 'cl1',
      orderedItemIds: ['id1', 'id2', 'id3'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty orderedItemIds array', () => {
    const result = reorderChecklistItemsSchema.safeParse({
      checklistId: 'cl1',
      orderedItemIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing checklistId', () => {
    const result = reorderChecklistItemsSchema.safeParse({ orderedItemIds: ['id1'] });
    expect(result.success).toBe(false);
  });
});
