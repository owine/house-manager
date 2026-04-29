import { describe, expect, it } from 'vitest';
import { createVendorSchema, updateVendorSchema } from '@/lib/vendors/schema';

describe('createVendorSchema', () => {
  it('accepts a minimal vendor', () => {
    const result = createVendorSchema.safeParse({ name: 'Plumber Pete' });
    expect(result.success).toBe(true);
  });

  it('accepts a fully-populated vendor', () => {
    const result = createVendorSchema.safeParse({
      name: 'Plumber Pete',
      kind: 'plumber',
      phone: '555-1234',
      email: 'pete@example.com',
      website: 'https://petesplumbing.example',
      address: '123 Pipe St',
      notes: 'Charges weekend rates',
      tags: ['emergency', 'after-hours'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = createVendorSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const result = createVendorSchema.safeParse({ name: 'X', email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid website URL', () => {
    const result = createVendorSchema.safeParse({ name: 'X', website: 'not a url' });
    expect(result.success).toBe(false);
  });
});

describe('updateVendorSchema', () => {
  it('requires id', () => {
    const result = updateVendorSchema.safeParse({ name: 'X' });
    expect(result.success).toBe(false);
  });

  it('accepts id-only partial update', () => {
    const result = updateVendorSchema.safeParse({ id: 'abc' });
    expect(result.success).toBe(true);
  });
});
