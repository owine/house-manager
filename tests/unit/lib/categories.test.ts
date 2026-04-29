import { describe, expect, it } from 'vitest';
import { categoryMetadataSchemas, metadataSchemaFor } from '@/lib/categories';

describe('categoryMetadataSchemas', () => {
  it('defines schemas for known categories', () => {
    expect(categoryMetadataSchemas.appliance).toBeDefined();
    expect(categoryMetadataSchemas.vehicle).toBeDefined();
    expect(categoryMetadataSchemas.hvac).toBeDefined();
  });
});

describe('metadataSchemaFor', () => {
  it('returns the typed schema for a known category', () => {
    const schema = metadataSchemaFor('vehicle');
    const parsed = schema.safeParse({ vin: '1HGBH41JXMN109186', licensePlate: 'ABC123' });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid typed metadata', () => {
    const schema = metadataSchemaFor('vehicle');
    const parsed = schema.safeParse({ vin: 'too-short' });
    expect(parsed.success).toBe(false);
  });

  it('falls back to a freeform record schema for unknown categories', () => {
    const schema = metadataSchemaFor('pool-equipment');
    const parsed = schema.safeParse({ gallons: 10000, chemical: 'chlorine' });
    expect(parsed.success).toBe(true);
  });

  it('freeform fallback rejects deeply-nested values', () => {
    const schema = metadataSchemaFor('pool-equipment');
    const parsed = schema.safeParse({ nested: { obj: 'value' } });
    expect(parsed.success).toBe(false);
  });
});
