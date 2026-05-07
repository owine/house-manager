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

  it('accepts serviceContract: true with a contractEndsOn date', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      serviceContract: true,
      contractEndsOn: '2027-01-15',
    });
    expect(result.success).toBe(true);
  });

  it('accepts serviceContract: true with no contractEndsOn', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      serviceContract: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts serviceContract: false with no contractEndsOn', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      serviceContract: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects contractEndsOn when serviceContract is false (Zod refine)', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      serviceContract: false,
      contractEndsOn: '2027-01-15',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('contractEndsOn');
    }
  });

  it('rejects contractEndsOn when serviceContract is omitted (defaults to false)', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      contractEndsOn: '2027-01-15',
    });
    expect(result.success).toBe(false);
  });

  it('normalizes contractEndsOn to UTC midnight (truncates non-midnight time)', () => {
    const result = vendorLinkSchema.safeParse({
      vendorId: 'v_1',
      role: 'SERVICE',
      serviceContract: true,
      contractEndsOn: new Date('2027-01-15T17:30:00Z'),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contractEndsOn?.toISOString()).toBe('2027-01-15T00:00:00.000Z');
    }
  });
});
