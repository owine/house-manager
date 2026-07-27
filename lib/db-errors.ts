import { Prisma } from '@prisma/client';

/**
 * Postgres SQLSTATEs for foreign-key violations.
 *
 * pg18 emits `23001` (restrict_violation) for RESTRICT-mode FKs where earlier
 * versions emitted `23503` (foreign_key_violation). Both are treated the same
 * here — the caller only cares that a dependent row blocked the write.
 */
const FK_VIOLATION_SQLSTATES = new Set(['23001', '23503']);

/**
 * Pull the Postgres SQLSTATE out of a Prisma error, wherever the current
 * adapter version happens to put it.
 *
 * `@prisma/adapter-pg` has never mapped `23001` to Prisma's own `P2003`, and
 * the shape of the unmapped error has already changed once:
 *
 * - **7.8.0** — leaked through as a raw `DriverAdapterError`, SQLSTATE at
 *   `err.cause.code`.
 * - **7.9.0** — surfaces as a `PrismaClientKnownRequestError` with code
 *   `P2039`, no `cause` at all, and the SQLSTATE moved to
 *   `err.meta.driverAdapterError.cause.code`. (Prisma 7.9.0 release notes,
 *   "Unmapped database errors from driver adapters now surface as a
 *   user-facing P2039".)
 *
 * The SQLSTATE itself is stable across both; only the envelope moved. So we
 * read every known location rather than pattern-matching one adapter version —
 * this has now broken twice on a minor bump, and the next envelope change
 * should not break it a third time.
 */
export function extractSqlState(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  // 7.9.0+: PrismaClientKnownRequestError P2039, SQLSTATE nested in meta.
  const meta = (err as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } }).meta;
  const metaCode = meta?.driverAdapterError?.cause?.code;
  if (typeof metaCode === 'string') return metaCode;

  // <= 7.8.0: raw DriverAdapterError with the SQLSTATE on `cause`.
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  if (typeof causeCode === 'string') return causeCode;

  return undefined;
}

/**
 * True when a write failed because a foreign key blocked it — whether Prisma
 * mapped it to `P2003` itself or left the raw Postgres SQLSTATE for us to find.
 *
 * Callers use this to convert an exception into a structured result (e.g.
 * "this vendor still has links") rather than letting it escape a server action,
 * which must never throw.
 */
export function isFkViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    return true;
  }
  const sqlState = extractSqlState(err);
  return sqlState !== undefined && FK_VIOLATION_SQLSTATES.has(sqlState);
}
