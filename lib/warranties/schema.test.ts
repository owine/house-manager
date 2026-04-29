import { describe, expect, it } from 'vitest';
import { createWarrantySchema, updateWarrantySchema } from '@/lib/warranties/schema';

describe('createWarrantySchema', () => {
  it('accepts a warranty with all fields', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme Warranty Co.',
      policyNumber: 'POL-12345',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
      coverage: 'Parts and labour',
      cost: 199.99,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a warranty with only required fields', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme Warranty Co.',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when endsOn is before startsOn', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme Warranty Co.',
      startsOn: '2026-01-01',
      endsOn: '2024-01-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const endsOnErrors = result.error.flatten().fieldErrors.endsOn;
      expect(endsOnErrors).toBeDefined();
      expect(endsOnErrors?.[0]).toMatch(/on or after/i);
    }
  });

  it('accepts when endsOn equals startsOn', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme Warranty Co.',
      startsOn: '2025-06-01',
      endsOn: '2025-06-01',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing itemId', () => {
    const result = createWarrantySchema.safeParse({
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string provider', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: '',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects provider exceeding 200 characters', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'x'.repeat(201),
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative cost', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
      cost: -5,
    });
    expect(result.success).toBe(false);
  });

  it('accepts cost of zero', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
      cost: 0,
    });
    expect(result.success).toBe(true);
  });

  it('coerces startsOn and endsOn from ISO strings to Date', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.startsOn).toBeInstanceOf(Date);
      expect(result.data.endsOn).toBeInstanceOf(Date);
    }
  });

  it('coerces cost from string to number', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
      cost: '149.50',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cost).toBe(149.5);
  });

  it('rejects coverage exceeding 20000 characters', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
      coverage: 'x'.repeat(20_001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects policyNumber exceeding 200 characters', () => {
    const result = createWarrantySchema.safeParse({
      itemId: 'item-001',
      provider: 'Acme',
      startsOn: '2024-01-01',
      endsOn: '2026-01-01',
      policyNumber: 'P'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe('updateWarrantySchema', () => {
  it('requires id', () => {
    const result = updateWarrantySchema.safeParse({
      provider: 'New Provider',
    });
    expect(result.success).toBe(false);
  });

  it('accepts id with no other fields (full partial)', () => {
    const result = updateWarrantySchema.safeParse({ id: 'warranty-123' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid partial update with id', () => {
    const result = updateWarrantySchema.safeParse({
      id: 'warranty-123',
      provider: 'Updated Provider',
      cost: 299,
    });
    expect(result.success).toBe(true);
  });

  it('rejects when both dates provided and endsOn < startsOn', () => {
    const result = updateWarrantySchema.safeParse({
      id: 'warranty-123',
      startsOn: '2026-01-01',
      endsOn: '2024-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('accepts partial update with only endsOn (no cross-field check applied)', () => {
    const result = updateWarrantySchema.safeParse({
      id: 'warranty-123',
      endsOn: '2027-01-01',
    });
    expect(result.success).toBe(true);
  });
});
