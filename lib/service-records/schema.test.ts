import { describe, expect, it } from 'vitest';
import { createServiceRecordSchema, updateServiceRecordSchema } from '@/lib/service-records/schema';

describe('createServiceRecordSchema', () => {
  it('accepts a minimal record with only required fields', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'Annual HVAC service',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a record with neither itemId nor vendorId (both nullable)', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'General maintenance',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.itemId).toBeUndefined();
      expect(result.data.vendorId).toBeUndefined();
    }
  });

  it('accepts a record with both itemId and vendorId', () => {
    const result = createServiceRecordSchema.safeParse({
      itemId: 'item-abc',
      vendorId: 'vendor-xyz',
      performedOn: '2024-03-15',
      summary: 'Full service with vendor',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a record with only itemId', () => {
    const result = createServiceRecordSchema.safeParse({
      itemId: 'item-abc',
      performedOn: '2024-03-15',
      summary: 'Self-performed repair',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a record with only vendorId', () => {
    const result = createServiceRecordSchema.safeParse({
      vendorId: 'vendor-xyz',
      performedOn: '2024-03-15',
      summary: 'Vendor service, item unknown',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing performedOn', () => {
    const result = createServiceRecordSchema.safeParse({ summary: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects missing summary', () => {
    const result = createServiceRecordSchema.safeParse({ performedOn: '2024-03-15' });
    expect(result.success).toBe(false);
  });

  it('rejects empty string summary', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects summary exceeding 200 characters', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('accepts summary of exactly 200 characters', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'x'.repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it('coerces performedOn from ISO string to Date', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-01-15',
      summary: 'Test',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.performedOn).toBeInstanceOf(Date);
  });

  it('coerces cost from string to number', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'Test',
      cost: '249.99',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cost).toBe(249.99);
  });

  it('rejects negative cost', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'Test',
      cost: -10,
    });
    expect(result.success).toBe(false);
  });

  it('accepts cost of zero', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'Test',
      cost: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional notes', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'Test',
      notes: '## Notes\n\nSome markdown content.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects notes exceeding 20000 characters', () => {
    const result = createServiceRecordSchema.safeParse({
      performedOn: '2024-03-15',
      summary: 'Test',
      notes: 'x'.repeat(20_001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects itemId as empty string (min 1 when provided)', () => {
    const result = createServiceRecordSchema.safeParse({
      itemId: '',
      performedOn: '2024-03-15',
      summary: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects vendorId as empty string (min 1 when provided)', () => {
    const result = createServiceRecordSchema.safeParse({
      vendorId: '',
      performedOn: '2024-03-15',
      summary: 'Test',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateServiceRecordSchema', () => {
  it('requires id', () => {
    const result = updateServiceRecordSchema.safeParse({
      summary: 'Updated summary',
    });
    expect(result.success).toBe(false);
  });

  it('accepts id with no other fields (full partial)', () => {
    const result = updateServiceRecordSchema.safeParse({ id: 'sr-123' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid partial update with id', () => {
    const result = updateServiceRecordSchema.safeParse({
      id: 'sr-123',
      summary: 'Replaced filter',
      cost: 150,
    });
    expect(result.success).toBe(true);
  });
});
