import { Prisma } from '@prisma/client';

export interface CostRollupInput {
  installCost: Prisma.Decimal | null;
  components: Array<{ purchasePrice: Prisma.Decimal | null; archivedAt: Date | null }>;
}

export interface CostRollupOutput {
  componentsSubtotal: Prisma.Decimal;
  installCost: Prisma.Decimal;
  total: Prisma.Decimal;
  hasAnyData: boolean;
}

/**
 * Compute the cost rollup for a System: sum of non-archived component
 * `purchasePrice` values plus the System's `installCost`. Pure — no DB
 * access. Archived components and null prices are excluded from the
 * subtotal. `hasAnyData` is true when either subtotal or installCost is
 * non-zero.
 */
export function computeCostRollup(input: CostRollupInput): CostRollupOutput {
  const subtotal = input.components.reduce((acc, c) => {
    if (c.archivedAt) return acc;
    if (!c.purchasePrice) return acc;
    return acc.plus(c.purchasePrice);
  }, new Prisma.Decimal(0));
  const install = input.installCost ?? new Prisma.Decimal(0);
  const total = subtotal.plus(install);
  const hasAnyData = !subtotal.isZero() || !install.isZero();
  return {
    componentsSubtotal: subtotal,
    installCost: install,
    total,
    hasAnyData,
  };
}
