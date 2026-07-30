const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

/**
 * Format a money amount for display.
 *
 * Accepts a string because the values reaching this are usually Prisma
 * `Decimal(10,2)` columns or their wire form — both of which arrive as strings
 * rather than numbers so they don't lose precision on the way. A value that
 * isn't finite is returned unchanged rather than rendered as "$NaN".
 */
export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? currencyFmt.format(n) : String(value);
}
