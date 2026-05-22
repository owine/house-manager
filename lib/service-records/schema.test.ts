import { describe, expect, it } from 'vitest';
import { createServiceRecordSchema, updateServiceRecordSchema } from '@/lib/service-records/schema';

describe('createServiceRecordSchema', () => {
  it('accepts a minimal record with one item-target', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'Annual HVAC service',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a record with one system-target', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ systemId: 'sys-xyz' }],
      performedOn: '2024-03-15',
      summary: 'Whole-system tune',
    });
    expect(result.success).toBe(true);
  });

  it('accepts multiple targets', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-a' }, { systemId: 'sys-b' }],
      performedOn: '2024-03-15',
      summary: 'Mixed work',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when both vendor and targets are missing', () => {
    // The cross-field rule requires at least one of vendor / targets.
    const result = createServiceRecordSchema.safeParse({
      targets: [],
      performedOn: '2024-03-15',
      summary: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a vendor-only record with no targets (e.g. landscaping)', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [],
      vendorId: 'vendor-acme',
      performedOn: '2024-03-15',
      summary: 'Lawn mowed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a target with both itemId and systemId set', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-a', systemId: 'sys-b' }],
      performedOn: '2024-03-15',
      summary: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a target with neither itemId nor systemId set', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{}],
      performedOn: '2024-03-15',
      summary: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a record with item-target and vendorId', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      vendorId: 'vendor-xyz',
      performedOn: '2024-03-15',
      summary: 'Full service with vendor',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing performedOn', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      summary: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing summary', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string summary', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects summary exceeding 200 characters', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('accepts summary of exactly 200 characters', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'x'.repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it('coerces performedOn from ISO string to Date', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-01-15',
      summary: 'Test',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.performedOn).toBeInstanceOf(Date);
  });

  it('coerces cost from string to number', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'Test',
      cost: '249.99',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cost).toBe(249.99);
  });

  it('rejects negative cost', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'Test',
      cost: -10,
    });
    expect(result.success).toBe(false);
  });

  it('accepts cost of zero', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'Test',
      cost: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional notes', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'Test',
      notes: '## Notes\n\nSome markdown content.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects notes exceeding 20000 characters', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
      performedOn: '2024-03-15',
      summary: 'Test',
      notes: 'x'.repeat(20_001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects vendorId as empty string (min 1 when provided)', () => {
    const result = createServiceRecordSchema.safeParse({
      targets: [{ itemId: 'item-abc' }],
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

  it('accepts targets in update payload', () => {
    const result = updateServiceRecordSchema.safeParse({
      id: 'sr-123',
      targets: [{ itemId: 'item-abc' }, { systemId: 'sys-xyz' }],
    });
    expect(result.success).toBe(true);
  });
});

const base = { performedOn: '2026-05-01', summary: 'Washed deck' };

describe('createServiceRecordSchema — self-performed', () => {
  it.each([
    [{ ...base, targets: [], vendorId: 'v1' }, true],
    [{ ...base, targets: [{ itemId: 'i1' }] }, true],
    [{ ...base, targets: [], selfPerformed: true }, true],
    [{ ...base, targets: [] }, false],
    [{ ...base, targets: [], selfPerformed: false }, false],
    [{ ...base, targets: [], selfPerformed: true, vendorId: 'v1' }, false],
    [{ ...base, targets: [{ itemId: 'i1' }], selfPerformed: true }, true],
  ])('parses %j → success=%s', (input, ok) => {
    expect(createServiceRecordSchema.safeParse(input).success).toBe(ok);
  });
  it('defaults selfPerformed to false', () => {
    const r = createServiceRecordSchema.parse({ ...base, targets: [], vendorId: 'v1' });
    expect(r.selfPerformed).toBe(false);
  });
});

describe('updateServiceRecordSchema — partial tolerates omitted fields', () => {
  it('accepts a partial update that omits selfPerformed and vendor', () => {
    expect(updateServiceRecordSchema.safeParse({ id: 'sr1', summary: 'Edited' }).success).toBe(
      true,
    );
  });
  it('rejects self-performed + vendor when both present in an update', () => {
    expect(
      updateServiceRecordSchema.safeParse({ id: 'sr1', selfPerformed: true, vendorId: 'v1' })
        .success,
    ).toBe(false);
  });
});
