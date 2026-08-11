import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { applyPrismaExtensions } from './prisma-extensions';

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return applyPrismaExtensions(new PrismaClient({ adapter, log: ['warn', 'error'] }));
}

// The extended client is a different type from PrismaClient; deriving it from the
// factory keeps the extensions' typing intact rather than erasing it.
type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * The transaction-scoped client `prisma.$transaction(fn)` hands its callback.
 *
 * Helpers that take a `tx` must use this rather than `Prisma.TransactionClient`
 * — that one describes the *unextended* client and is not assignable from the
 * one `applyPrismaExtensions` produces. Derived here, next to the client it
 * belongs to, so the extraction has one home to update.
 */
export type TransactionClient = Parameters<Parameters<ExtendedPrismaClient['$transaction']>[0]>[0];

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma: ExtendedPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
