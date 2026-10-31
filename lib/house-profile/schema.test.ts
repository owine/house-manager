import { describe, expect, it } from 'vitest';
import { houseProfileSchema } from '@/lib/house-profile/schema';

describe('houseProfileSchema', () => {
  it('accepts an empty object', () => {
    expect(houseProfileSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully-populated profile', () => {
    const result = houseProfileSchema.safeParse({
      location: 'San Diego, CA',
      climateZone: '3B',
      propertyType: 'single-family',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty strings for location and climateZone', () => {
    const result = houseProfileSchema.safeParse({ location: '', climateZone: '' });
    expect(result.success).toBe(true);
  });

  it('rejects location exceeding 200 chars', () => {
    const result = houseProfileSchema.safeParse({ location: 'x'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('rejects climateZone exceeding 50 chars', () => {
    const result = houseProfileSchema.safeParse({ climateZone: 'z'.repeat(51) });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid propertyType', () => {
    const result = houseProfileSchema.safeParse({ propertyType: 'mansion' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid propertyType enum values', () => {
    for (const val of ['single-family', 'townhome', 'condo', 'multi-family', 'other'] as const) {
      expect(houseProfileSchema.safeParse({ propertyType: val }).success).toBe(true);
    }
  });

  it("accepts any IANA zone, not only the picker's list", () => {
    for (const timezone of ['America/Chicago', 'UTC', 'Asia/Kathmandu', 'US/Central']) {
      expect(houseProfileSchema.safeParse({ timezone }).success).toBe(true);
    }
  });

  it('rejects a timezone Intl does not know', () => {
    // Stored, it would make tzParts throw in every date path: overdue, ticks, digests.
    const result = houseProfileSchema.safeParse({ timezone: 'Mars/Olympus' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors.timezone).toBeDefined();
  });
});
