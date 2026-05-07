import { describe, expect, it } from 'vitest';
import { vendorLinkSchema, vendorRoleEnum } from './schema';

describe('vendorLinkSchema', () => {
  it('accepts a link with vendorId only', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_123',
      role: 'INSTALLER',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a link with freeformName only', () => {
    const result = vendorLinkSchema.safeParse({
      freeformName: 'Some One-Off Plumber',
      role: 'SERVICE',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a link with both vendorId and freeformName set', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_123',
      freeformName: 'Bob',
      role: 'PURCHASE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a link with neither vendorId nor freeformName set', () => {
    const result = vendorLinkSchema.safeParse({ role: 'PURCHASE' });
    expect(result.success).toBe(false);
  });

  it('requires role', () => {
    const result = vendorLinkSchema.safeParse({ vendorId: 'v_1' });
    expect(result.success).toBe(false);
  });

  it('rejects freeformName longer than 120 characters', () => {
    const result = vendorLinkSchema.safeParse({
      freeformName: 'x'.repeat(121),
      role: 'OTHER',
    });
    expect(result.success).toBe(false);
  });

  it('accepts notes up to 20_000 chars', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      notes: 'x'.repeat(20_000),
    });
    expect(result.success).toBe(true);
  });

  it('rejects notes longer than 20_000 chars', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      notes: 'x'.repeat(20_001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts every VendorRole enum value', () => {
    const roles = vendorRoleEnum.options;
    expect(roles).toEqual([
      'PURCHASE',
      'INSTALLER',
      'SERVICE',
      'WARRANTY_PROVIDER',
      'MANUFACTURER',
      'OTHER',
    ]);
    for (const role of roles) {
      const result = vendorLinkSchema.safeParse({ vendorId: 'v_1', role });
      expect(result.success, `role ${role} should be accepted`).toBe(true);
    }
  });

  it('treats null vendorId/freeformName as unset (rejects when both null)', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: null,
      freeformName: null,
      role: 'OTHER',
    });
    expect(result.success).toBe(false);
  });
});
