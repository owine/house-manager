import { describe, expect, it } from 'vitest';

import { partKindConfigs, partKindSchemaFor } from './kinds';

describe('partKindConfigs', () => {
  it('has a schema for every PartKind', () => {
    expect(Object.keys(partKindConfigs).sort()).toEqual(
      ['AIR_FILTER', 'BATTERY', 'BELT', 'BULB', 'CHEMICAL', 'FUSE', 'OTHER', 'WATER_FILTER'].sort(),
    );
  });
});

describe('partKindSchemaFor(BULB)', () => {
  const schema = partKindSchemaFor('BULB');

  it('accepts a full bulb spec', () => {
    const input = {
      base: 'E26',
      shape: 'BR30',
      technology: 'LED',
      watts: 9,
      wattEquivalent: 65,
      lumens: 650,
      colorTempK: 2700,
      cri: 90,
      dimmable: true,
      voltage: 120,
      ratedHours: 25000,
    };
    expect(schema.parse(input)).toEqual(input);
  });

  it('accepts a partial spec — a user may know only base and wattage', () => {
    expect(schema.parse({ base: 'E12', watts: 4 })).toEqual({ base: 'E12', watts: 4 });
  });

  it('keeps base and shape independent', () => {
    expect(schema.parse({ base: 'E26', shape: 'A19' })).toEqual({ base: 'E26', shape: 'A19' });
    expect(schema.parse({ base: 'E26', shape: 'PAR38' })).toEqual({ base: 'E26', shape: 'PAR38' });
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ base: 'E26', packQuantity: 4 })).toEqual({ base: 'E26' });
  });

  it('rejects an unknown enum member', () => {
    expect(schema.safeParse({ base: 'E27' }).success).toBe(false);
  });

  it('rejects negative or zero numeric specs', () => {
    expect(schema.safeParse({ watts: -1 }).success).toBe(false);
    expect(schema.safeParse({ lumens: -100 }).success).toBe(false);
    expect(schema.safeParse({ colorTempK: 0 }).success).toBe(false);
    expect(schema.safeParse({ ratedHours: -1 }).success).toBe(false);
    expect(schema.safeParse({ voltage: -120 }).success).toBe(false);
  });
});

describe('partKindSchemaFor(AIR_FILTER)', () => {
  const schema = partKindSchemaFor('AIR_FILTER');

  it('accepts a full spec', () => {
    const input = {
      nominalSize: '20x25x1',
      actualSize: '19.5x24.5x0.75',
      merv: 11,
      mpr: 1500,
      fpr: 7,
      pleated: true,
      ratedMonths: 3,
    };
    expect(schema.parse(input)).toEqual(input);
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ merv: 13, brand: 'Filtrete' })).toEqual({ merv: 13 });
  });

  it('rejects negative ratings', () => {
    expect(schema.safeParse({ merv: -1 }).success).toBe(false);
    expect(schema.safeParse({ mpr: -1 }).success).toBe(false);
    expect(schema.safeParse({ fpr: -1 }).success).toBe(false);
    expect(schema.safeParse({ ratedMonths: -3 }).success).toBe(false);
  });
});

describe('partKindSchemaFor(WATER_FILTER)', () => {
  const schema = partKindSchemaFor('WATER_FILTER');

  it('accepts a full spec', () => {
    const input = {
      cartridgeType: 'carbon block',
      micronRating: 0.5,
      capacityGallons: 300,
      ratedMonths: 6,
    };
    expect(schema.parse(input)).toEqual(input);
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ ratedMonths: 6, color: 'blue' })).toEqual({ ratedMonths: 6 });
  });

  it('rejects an unknown cartridge type', () => {
    expect(schema.safeParse({ cartridgeType: 'magic' }).success).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(schema.safeParse({ micronRating: -0.5 }).success).toBe(false);
    expect(schema.safeParse({ capacityGallons: -1 }).success).toBe(false);
    expect(schema.safeParse({ ratedMonths: -1 }).success).toBe(false);
  });
});

describe('partKindSchemaFor(BATTERY)', () => {
  const schema = partKindSchemaFor('BATTERY');

  it('accepts a full spec', () => {
    const input = {
      size: 'CR2032',
      chemistry: 'lithium',
      voltage: 3,
      capacityMah: 225,
      rechargeable: false,
    };
    expect(schema.parse(input)).toEqual(input);
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ size: 'AA', packQuantity: 8 })).toEqual({ size: 'AA' });
  });

  it('rejects an unknown size', () => {
    expect(schema.safeParse({ size: 'AAAA' }).success).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(schema.safeParse({ voltage: -1.5 }).success).toBe(false);
    expect(schema.safeParse({ capacityMah: -2000 }).success).toBe(false);
  });
});

describe('partKindSchemaFor(BELT)', () => {
  const schema = partKindSchemaFor('BELT');

  it('accepts a full spec', () => {
    const input = { beltType: 'V-belt', length: '40in', profile: '4L' };
    expect(schema.parse(input)).toEqual(input);
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ beltType: 'serpentine', width: '1in' })).toEqual({
      beltType: 'serpentine',
    });
  });
});

describe('partKindSchemaFor(FUSE)', () => {
  const schema = partKindSchemaFor('FUSE');

  it('accepts a full spec', () => {
    const input = { amps: 15, voltage: 250, fuseType: 'ceramic', fastBlow: true };
    expect(schema.parse(input)).toEqual(input);
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ amps: 20, brand: 'Bussmann' })).toEqual({ amps: 20 });
  });

  it('rejects non-positive electrical ratings', () => {
    expect(schema.safeParse({ amps: 0 }).success).toBe(false);
    expect(schema.safeParse({ voltage: -250 }).success).toBe(false);
  });
});

describe('partKindSchemaFor(CHEMICAL)', () => {
  const schema = partKindSchemaFor('CHEMICAL');

  it('accepts a full spec', () => {
    const input = { form: 'pellet', concentration: '99.8% NaCl', containerSize: '40lb bag' };
    expect(schema.parse(input)).toEqual(input);
  });

  it('strips unknown keys', () => {
    expect(schema.parse({ form: 'liquid', hazard: 'corrosive' })).toEqual({ form: 'liquid' });
  });

  it('rejects an unknown form', () => {
    expect(schema.safeParse({ form: 'gas' }).success).toBe(false);
  });
});

describe('partKindSchemaFor(OTHER)', () => {
  const schema = partKindSchemaFor('OTHER');

  it('accepts arbitrary primitive key/values', () => {
    expect(schema.parse({ colour: 'red', count: 3, spare: true, note: null })).toEqual({
      colour: 'red',
      count: 3,
      spare: true,
      note: null,
    });
  });

  it('rejects reserved `_`-prefixed keys', () => {
    expect(schema.safeParse({ _provenance: 'ai' }).success).toBe(false);
  });

  it('puts the reserved-key issue on the record root, not per-key', () => {
    const result = schema.safeParse({ _provenance: 'ai' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].path.length).toBe(0);
  });
});
