import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeItem,
  canonicalizePart,
  canonicalizeServiceRecord,
  canonicalizeWarranty,
} from './canonicalize';

// Regression for a silent, repo-wide data-quality bug.
//
// `@db.Decimal` columns arrive from the pg adapter as `Prisma.Decimal` OBJECTS.
// `fmtMoney` previously accepted only `number | string`, and every call site
// cast the Decimal away — so the compiler was happy while
// `Number.isFinite(anObject)` was false and the money line silently vanished.
// Every Item, Warranty and ServiceRecord embedding in the database was missing
// its price or cost, with no error anywhere.
//
// These tests pass a REAL Prisma.Decimal, which is the shape production
// actually produces. Passing a number or string would pass against the bug.
describe('money survives a real Prisma.Decimal', () => {
  const D = (v: string) => new Prisma.Decimal(v);

  it('canonicalizeItem keeps purchasePrice', () => {
    const text = canonicalizeItem({
      name: 'Fridge',
      category: { name: 'Appliance' },
      purchasePrice: D('1299.00'),
    });
    expect(text).toContain('$1299.00');
  });

  it('canonicalizeServiceRecord keeps cost', () => {
    const text = canonicalizeServiceRecord({
      summary: 'Furnace tune-up',
      cost: D('189.50'),
    } as Parameters<typeof canonicalizeServiceRecord>[0]);
    expect(text).toContain('$189.50');
  });

  it('canonicalizeWarranty keeps cost', () => {
    const text = canonicalizeWarranty({
      provider: 'Acme',
      cost: D('75.25'),
    } as Parameters<typeof canonicalizeWarranty>[0]);
    expect(text).toContain('$75.25');
  });

  it('canonicalizePart keeps typicalCost', () => {
    const text = canonicalizePart({
      name: 'BR30 bulb',
      kind: 'BULB',
      typicalCost: D('32.50'),
    } as Parameters<typeof canonicalizePart>[0]);
    expect(text).toContain('$32.50');
  });

  it('still handles number, string and null', () => {
    const base = { name: 'X', category: { name: 'C' } };
    expect(canonicalizeItem({ ...base, purchasePrice: 12 })).toContain('$12.00');
    expect(canonicalizeItem({ ...base, purchasePrice: '12.5' })).toContain('$12.50');
    expect(canonicalizeItem({ ...base, purchasePrice: null })).not.toContain('$');
    expect(canonicalizeItem({ ...base, purchasePrice: '' })).not.toContain('$');
  });
});
