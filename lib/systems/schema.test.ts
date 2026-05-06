import { describe, expect, it } from 'vitest';
import { SystemCreateSchema, SystemUpdateSchema } from './schema';

describe('SystemCreateSchema', () => {
  it('accepts a valid create payload', () => {
    const result = SystemCreateSchema.safeParse({
      name: 'HVAC',
      kind: 'hvac',
      location: 'Basement',
      installDate: '2024-01-15',
      installCost: 5400.5,
      notes: 'Trane XR16',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the minimum required payload', () => {
    const result = SystemCreateSchema.safeParse({ name: 'Boiler' });
    expect(result.success).toBe(true);
  });

  it('rejects when name is missing', () => {
    const result = SystemCreateSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects when name is empty', () => {
    const result = SystemCreateSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects names longer than 120 characters', () => {
    const result = SystemCreateSchema.safeParse({ name: 'x'.repeat(121) });
    expect(result.success).toBe(false);
  });

  it('rejects negative install cost', () => {
    const result = SystemCreateSchema.safeParse({ name: 'HVAC', installCost: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts zero install cost', () => {
    const result = SystemCreateSchema.safeParse({ name: 'HVAC', installCost: 0 });
    expect(result.success).toBe(true);
  });

  it('allows optional fields to be null', () => {
    const result = SystemCreateSchema.safeParse({
      name: 'HVAC',
      kind: null,
      location: null,
      installDate: null,
      installCost: null,
      notes: null,
    });
    expect(result.success).toBe(true);
  });

  it('allows optional fields to be undefined', () => {
    const result = SystemCreateSchema.safeParse({ name: 'HVAC' });
    expect(result.success).toBe(true);
  });
});

describe('SystemUpdateSchema', () => {
  it('accepts an empty partial update', () => {
    const result = SystemUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a single-field update', () => {
    const result = SystemUpdateSchema.safeParse({ location: 'Garage' });
    expect(result.success).toBe(true);
  });

  it('still rejects an over-length name on update', () => {
    const result = SystemUpdateSchema.safeParse({ name: 'x'.repeat(121) });
    expect(result.success).toBe(false);
  });
});
