import { describe, expect, it } from 'vitest';

import { isReservedMetadataKey, RESERVED_METADATA_PREFIX } from './reserved-keys';

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
