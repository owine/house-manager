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

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma: ExtendedPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
