import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { calendarDateWriteGuard } from './calendar-date-guard';

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  // The calendar-date columns are Postgres `date`, so a time component cannot
  // survive a read -- but Prisma will silently TRUNCATE one on write, storing the
  // wrong day. The guard makes that throw. See lib/calendar-date-guard.ts.
  return new PrismaClient({ adapter, log: ['warn', 'error'] }).$extends(calendarDateWriteGuard);
}

// The extended client is a different type from PrismaClient; deriving it from the
// factory keeps the extension's typing intact rather than erasing it.
type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma: ExtendedPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
