import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { computeCostRollup } from './cost-rollup';

const D = (n: string | number) => new Prisma.Decimal(n);

describe('computeCostRollup', () => {
  it('sums two priced active components with no installCost', () => {
    const out = computeCostRollup({
      installCost: null,
      components: [
        { purchasePrice: D(100), archivedAt: null },
        { purchasePrice: D(200), archivedAt: null },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('300');
    expect(out.installCost.toString()).toBe('0');
    expect(out.total.toString()).toBe('300');
    expect(out.hasAnyData).toBe(true);
  });

  it('adds installCost on top of components subtotal', () => {
    const out = computeCostRollup({
      installCost: D(50),
      components: [
        { purchasePrice: D(100), archivedAt: null },
        { purchasePrice: D(200), archivedAt: null },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('300');
    expect(out.installCost.toString()).toBe('50');
    expect(out.total.toString()).toBe('350');
    expect(out.hasAnyData).toBe(true);
  });

  it('excludes archived components even if priced', () => {
    const out = computeCostRollup({
      installCost: null,
      components: [
        { purchasePrice: D(100), archivedAt: null },
        { purchasePrice: D(999), archivedAt: new Date('2026-01-01') },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('100');
    expect(out.total.toString()).toBe('100');
  });

  it('treats null purchasePrice as zero (skipped)', () => {
    const out = computeCostRollup({
      installCost: null,
      components: [
        { purchasePrice: D(100), archivedAt: null },
        { purchasePrice: null, archivedAt: null },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('100');
    expect(out.total.toString()).toBe('100');
  });

  it('returns zeros and hasAnyData=false when nothing has data', () => {
    const out = computeCostRollup({
      installCost: null,
      components: [
        { purchasePrice: null, archivedAt: null },
        { purchasePrice: null, archivedAt: new Date('2026-01-01') },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('0');
    expect(out.installCost.toString()).toBe('0');
    expect(out.total.toString()).toBe('0');
    expect(out.hasAnyData).toBe(false);
  });

  it('reports hasAnyData=true when only installCost is set', () => {
    const out = computeCostRollup({
      installCost: D(750),
      components: [],
    });
    expect(out.componentsSubtotal.toString()).toBe('0');
    expect(out.installCost.toString()).toBe('750');
    expect(out.total.toString()).toBe('750');
    expect(out.hasAnyData).toBe(true);
  });

  it('mixed: only the priced active component contributes', () => {
    const out = computeCostRollup({
      installCost: null,
      components: [
        { purchasePrice: D(100), archivedAt: null },
        { purchasePrice: D(500), archivedAt: new Date('2026-01-01') },
        { purchasePrice: null, archivedAt: null },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('100');
    expect(out.total.toString()).toBe('100');
    expect(out.hasAnyData).toBe(true);
  });

  it('preserves decimal precision (no float rounding)', () => {
    const out = computeCostRollup({
      installCost: null,
      components: [
        { purchasePrice: D('100.50'), archivedAt: null },
        { purchasePrice: D('200.25'), archivedAt: null },
      ],
    });
    expect(out.componentsSubtotal.toString()).toBe('300.75');
    expect(out.total.toString()).toBe('300.75');
  });
});
