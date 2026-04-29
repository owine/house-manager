import { prisma } from '@/lib/db';

/**
 * Returns the singleton HouseProfile row, or null if none has been saved yet.
 * Split into queries.ts (rather than merged into actions.ts) to match the
 * project-wide convention used by items, vendors, notes, warranties, and
 * service-records.
 */
export async function getHouseProfile() {
  return prisma.houseProfile.findFirst();
}
