import { describe, expect, it } from 'vitest';

import {
  isReservedMetadataKey,
  RESERVED_METADATA_PREFIX,
  visibleMetadataEntries,
} from './reserved-keys';

describe('isReservedMetadataKey', () => {
  it('returns true for keys starting with the reserved prefix', () => {
    expect(isReservedMetadataKey('_provenance')).toBe(true);
    expect(isReservedMetadataKey('_notes')).toBe(true);
  });

  it('returns true for the bare prefix itself', () => {
    expect(isReservedMetadataKey(RESERVED_METADATA_PREFIX)).toBe(true);
    expect(isReservedMetadataKey('_')).toBe(true);
  });

  it('returns false for normal keys, including ones containing an underscore mid-string', () => {
    expect(isReservedMetadataKey('wattage')).toBe(false);
    expect(isReservedMetadataKey('max_psi')).toBe(false);
  });
});

describe('visibleMetadataEntries', () => {
  it('drops reserved keys and keeps the rest', () => {
    expect(
      visibleMetadataEntries({ _provenance: { name: 'user' }, base: 'E26', watts: 9 }),
    ).toEqual([
      ['base', 'E26'],
      ['watts', 9],
    ]);
  });

  it('returns an empty array when only reserved keys are present', () => {
    // Callers use `.length` as the "is there anything to show?" test — an
    // empty card with a heading and no rows is its own bug.
    expect(visibleMetadataEntries({ _provenance: {} })).toEqual([]);
  });

  it('tolerates the shapes a Prisma Json column can actually hold', () => {
    expect(visibleMetadataEntries(null)).toEqual([]);
    expect(visibleMetadataEntries(undefined)).toEqual([]);
    expect(visibleMetadataEntries('a string')).toEqual([]);
    expect(visibleMetadataEntries(['an', 'array'])).toEqual([]);
  });
});
