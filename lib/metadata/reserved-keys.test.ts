import { describe, expect, it } from 'vitest';

import {
  isReservedMetadataKey,
  RESERVED_METADATA_PREFIX,
  stripReservedMetadata,
  visibleMetadataEntries,
  withStoredReservedMetadata,
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

const PROVENANCE = { name: 'user', amps: 'inferred' };

describe('stripReservedMetadata', () => {
  it('returns the visible keys as an object', () => {
    expect(stripReservedMetadata({ _provenance: PROVENANCE, amps: 15 })).toEqual({ amps: 15 });
  });

  it('returns an empty object for the non-object shapes a Json column can hold', () => {
    for (const v of [null, undefined, 'a string', ['an', 'array']]) {
      expect(stripReservedMetadata(v)).toEqual({});
    }
  });
});

describe('withStoredReservedMetadata', () => {
  it('re-attaches the stored reserved keys to the incoming spec', () => {
    expect(withStoredReservedMetadata({ amps: 20 }, { _provenance: PROVENANCE, amps: 15 })).toEqual(
      { amps: 20, _provenance: PROVENANCE },
    );
  });

  it('discards a reserved key the client sent in favour of the stored one', () => {
    expect(
      withStoredReservedMetadata(
        { amps: 20, _provenance: { name: 'forged' } },
        { _provenance: PROVENANCE },
      ),
    ).toEqual({ amps: 20, _provenance: PROVENANCE });
  });

  it('drops a client-sent reserved key when nothing is stored', () => {
    expect(withStoredReservedMetadata({ amps: 20, _provenance: {} }, { amps: 15 })).toEqual({
      amps: 20,
    });
  });

  it('tolerates a null stored blob', () => {
    expect(withStoredReservedMetadata({ amps: 20 }, null)).toEqual({ amps: 20 });
  });
});
