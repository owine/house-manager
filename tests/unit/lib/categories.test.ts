import { describe, expect, it } from 'vitest';
import {
  categoryConfigFor,
  categoryConfigs,
  metadataSchemaFor,
  visibleMetadataFields,
} from '@/lib/categories';

describe('categoryConfigs', () => {
  it('defines schemas for known categories', () => {
    expect(categoryConfigs.appliance).toBeDefined();
    expect(categoryConfigs.vehicle).toBeDefined();
    expect(categoryConfigs.hvac).toBeDefined();
  });

  it('exposes a typeField + visibility map for appliance and hvac', () => {
    expect(categoryConfigFor('appliance')?.typeField).toBe('applianceType');
    expect(categoryConfigFor('hvac')?.typeField).toBe('hvacType');
  });
});

describe('visibleMetadataFields', () => {
  it('shows only always-on fields when no typeField value is picked', () => {
    const config = categoryConfigFor('appliance');
    if (!config?.schema || !(config.schema instanceof Object)) throw new Error('config missing');
    // biome-ignore lint/suspicious/noExplicitAny: schema introspection
    const keys = Object.keys((config.schema as any).shape);
    const visible = visibleMetadataFields('appliance', keys, undefined);
    // discriminator + always-on (color, fuelType, dimensions) visible;
    // capacity/btu/etc. hidden until applianceType is picked
    expect(visible).toContain('applianceType');
    expect(visible).toContain('color');
    expect(visible).not.toContain('btu');
    expect(visible).not.toContain('capacityCuFt');
  });

  it('shows type-specific fields once the discriminator is set', () => {
    const config = categoryConfigFor('appliance');
    // biome-ignore lint/suspicious/noExplicitAny: schema introspection
    const keys = Object.keys((config?.schema as any).shape);
    const fridge = visibleMetadataFields('appliance', keys, 'refrigerator');
    expect(fridge).toContain('capacityCuFt');
    expect(fridge).toContain('waterLineRequired');
    expect(fridge).not.toContain('btu');
    expect(fridge).not.toContain('decibelRating');

    const dishwasher = visibleMetadataFields('appliance', keys, 'dishwasher');
    expect(dishwasher).toContain('decibelRating');
    expect(dishwasher).toContain('waterLineRequired');
    expect(dishwasher).not.toContain('capacityCuFt');
  });

  it('returns the full key list for categories without a typeField', () => {
    const config = categoryConfigFor('plumbing');
    // biome-ignore lint/suspicious/noExplicitAny: schema introspection
    const keys = Object.keys((config?.schema as any).shape);
    expect(visibleMetadataFields('plumbing', keys, undefined)).toEqual(keys);
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
