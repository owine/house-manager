import { describe, expect, it } from 'vitest';
import { createItemSchema, updateItemSchema } from '@/lib/items/schema';

describe('createItemSchema', () => {
  it('accepts a minimal item', () => {
    const result = createItemSchema.safeParse({
      name: 'Furnace',
      categorySlug: 'hvac',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = createItemSchema.safeParse({ categorySlug: 'hvac' });
    expect(result.success).toBe(false);
  });

  it('rejects missing categorySlug', () => {
    const result = createItemSchema.safeParse({ name: 'X' });
    expect(result.success).toBe(false);
  });

  it('coerces purchaseDate from ISO string', () => {
    const result = createItemSchema.safeParse({
      name: 'X',
      categorySlug: 'hvac',
      purchaseDate: '2024-01-15',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.purchaseDate).toBeInstanceOf(Date);
  });

  it('coerces purchasePrice from string', () => {
    const result = createItemSchema.safeParse({
      name: 'X',
      categorySlug: 'hvac',
      purchasePrice: '1234.56',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.purchasePrice).toBe(1234.56);
  });
});

describe('updateItemSchema', () => {
  it('requires id', () => {
    const result = updateItemSchema.safeParse({ name: 'X' });
    expect(result.success).toBe(false);
  });
});
