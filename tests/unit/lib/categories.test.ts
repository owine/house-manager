import { describe, expect, it } from 'vitest';
import {
  categoryConfigFor,
  categoryConfigs,
  metadataSchemaFor,
  visibleMetadataFields,
} from '@/lib/categories';

function schemaKeys(slug: string): string[] {
  const config = categoryConfigFor(slug);
  if (!config) throw new Error(`no category config for '${slug}'`);
  // biome-ignore lint/suspicious/noExplicitAny: schema introspection
  return Object.keys((config.schema as any).shape);
}

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

  it('exposes a typeField + visibility map for vehicle, tool, and landscaping', () => {
    expect(categoryConfigFor('vehicle')?.typeField).toBe('vehicleType');
    expect(categoryConfigFor('tool')?.typeField).toBe('toolType');
    expect(categoryConfigFor('landscaping')?.typeField).toBe('landscapingType');
  });
});

describe('visibleMetadataFields — vehicle', () => {
  it('shows mileage for cars but engineHours for boats', () => {
    const keys = schemaKeys('vehicle');
    const car = visibleMetadataFields('vehicle', keys, 'car');
    expect(car).toContain('mileage');
    expect(car).toContain('vin');
    expect(car).not.toContain('engineHours');

    const boat = visibleMetadataFields('vehicle', keys, 'boat');
    expect(boat).toContain('engineHours');
    expect(boat).not.toContain('mileage');
    expect(boat).not.toContain('vin');
  });

  it('shows tireSize for trailers but no engine fields', () => {
    const keys = schemaKeys('vehicle');
    const trailer = visibleMetadataFields('vehicle', keys, 'trailer');
    expect(trailer).toContain('tireSize');
    expect(trailer).not.toContain('engineDisplacement');
    expect(trailer).not.toContain('mileage');
    expect(trailer).not.toContain('engineHours');
  });
});

describe('visibleMetadataFields — tool', () => {
  it('shows mower-specific fields for lawn-mower', () => {
    const keys = schemaKeys('tool');
    const mower = visibleMetadataFields('tool', keys, 'lawn-mower');
    expect(mower).toContain('cuttingWidthInches');
    expect(mower).toContain('bagCapacityBushels');
    expect(mower).toContain('bladeSize');
    expect(mower).not.toContain('maxPsi');
    expect(mower).not.toContain('outputWatts');
  });

  it('shows tank+psi for compressors and watts for generators', () => {
    const keys = schemaKeys('tool');
    const compressor = visibleMetadataFields('tool', keys, 'air-compressor');
    expect(compressor).toContain('maxPsi');
    expect(compressor).toContain('tankGallons');
    expect(compressor).not.toContain('outputWatts');

    const generator = visibleMetadataFields('tool', keys, 'generator');
    expect(generator).toContain('outputWatts');
    expect(generator).not.toContain('maxPsi');
  });
});

describe('visibleMetadataFields — landscaping', () => {
  it('shows species + plantedDate for trees, fence fields for fence-section', () => {
    const keys = schemaKeys('landscaping');
    const tree = visibleMetadataFields('landscaping', keys, 'tree');
    expect(tree).toContain('speciesOrCultivar');
    expect(tree).toContain('plantedDate');
    expect(tree).not.toContain('fenceMaterial');
    expect(tree).not.toContain('zoneCount');

    const fence = visibleMetadataFields('landscaping', keys, 'fence-section');
    expect(fence).toContain('fenceMaterial');
    expect(fence).toContain('fenceLinearFeet');
    expect(fence).toContain('fenceHeightFeet');
    expect(fence).not.toContain('speciesOrCultivar');
  });

  it('keeps legacy `coverageArea` (string) always visible for back-compat', () => {
    const keys = schemaKeys('landscaping');
    const irrigation = visibleMetadataFields('landscaping', keys, 'irrigation-zone');
    expect(irrigation).toContain('coverageArea');
    expect(irrigation).toContain('sprinklerHeadCount');
  });
});

describe('visibleMetadataFields', () => {
  it('shows only always-on fields when no typeField value is picked', () => {
    const keys = schemaKeys('appliance');
    const visible = visibleMetadataFields('appliance', keys, undefined);
    // discriminator + always-on (color, fuelType, dimensions) visible;
    // capacity/btu/etc. hidden until applianceType is picked
    expect(visible).toContain('applianceType');
    expect(visible).toContain('color');
    expect(visible).not.toContain('btu');
    expect(visible).not.toContain('capacityCuFt');
  });

  it('shows type-specific fields once the discriminator is set', () => {
    const keys = schemaKeys('appliance');
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
    const keys = schemaKeys('plumbing');
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
