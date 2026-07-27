import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { extractSqlState, isFkViolation } from './db-errors';

// The fixtures below are the REAL error shapes observed against pg18, captured
// by deleting a vendor that still has an ItemVendor link. Keeping both versions
// here is the point of this file: the integration suite only ever exercises
// whichever adapter is currently installed, so a shape change on a minor bump
// is invisible until CI breaks. These make it a unit-test failure instead.

/** @prisma/adapter-pg 7.9.0: P2039, no `cause`, SQLSTATE nested under `meta`. */
function pg79RestrictError() {
  const err = new Prisma.PrismaClientKnownRequestError('Database error. Code: `23001`.', {
    code: 'P2039',
    clientVersion: '7.9.0',
  });
  (err as unknown as { meta: unknown }).meta = {
    modelName: 'Vendor',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23001',
        kind: 'postgres',
        code: '23001',
        severity: 'ERROR',
        message:
          'update or delete on table "vendors" violates RESTRICT setting of foreign key constraint "item_vendors_vendorId_fkey" on table "item_vendors"',
      },
    },
  };
  return err;
}

/** @prisma/adapter-pg <= 7.8.0: raw driver error, SQLSTATE on `cause`. */
function pg78RestrictError() {
  const err = new Error('DriverAdapterError');
  (err as unknown as { cause: unknown }).cause = {
    kind: 'postgres',
    code: '23001',
    message: 'violates RESTRICT setting of foreign key constraint',
  };
  return err;
}

describe('extractSqlState', () => {
  it('reads the SQLSTATE from the 7.9.0 meta.driverAdapterError shape', () => {
    expect(extractSqlState(pg79RestrictError())).toBe('23001');
  });

  it('reads the SQLSTATE from the <=7.8.0 cause shape', () => {
    expect(extractSqlState(pg78RestrictError())).toBe('23001');
  });

  it('returns undefined when there is no SQLSTATE anywhere', () => {
    expect(extractSqlState(new Error('boom'))).toBeUndefined();
    expect(extractSqlState(null)).toBeUndefined();
    expect(extractSqlState(undefined)).toBeUndefined();
    expect(extractSqlState('a string')).toBeUndefined();
    expect(extractSqlState({ cause: { code: 42 } })).toBeUndefined();
  });
});

describe('isFkViolation', () => {
  it('detects a RESTRICT violation on 7.9.0', () => {
    expect(isFkViolation(pg79RestrictError())).toBe(true);
  });

  it('detects a RESTRICT violation on <=7.8.0', () => {
    expect(isFkViolation(pg78RestrictError())).toBe(true);
  });

  it('detects the 23503 SQLSTATE emitted by pre-pg18 servers', () => {
    expect(isFkViolation({ cause: { code: '23503' } })).toBe(true);
  });

  it("detects Prisma's own P2003 mapping", () => {
    const err = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: '7.9.0',
    });
    expect(isFkViolation(err)).toBe(true);
  });

  it('does not fire on unrelated database errors', () => {
    // A unique-constraint violation must NOT be reported as an FK violation —
    // the caller would tell the user about links that do not exist.
    expect(isFkViolation({ cause: { code: '23505' } })).toBe(false);

    const notFound = new Prisma.PrismaClientKnownRequestError('nope', {
      code: 'P2025',
      clientVersion: '7.9.0',
    });
    expect(isFkViolation(notFound)).toBe(false);
  });

  it('does not fire on a non-database error', () => {
    expect(isFkViolation(new Error('network down'))).toBe(false);
    expect(isFkViolation(null)).toBe(false);
  });
});
