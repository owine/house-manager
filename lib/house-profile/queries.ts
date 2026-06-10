import { prisma } from '@/lib/db';
import { HOUSE_DEFAULT_TIMEZONE } from '@/lib/time/timezones';

/**
 * Returns the singleton HouseProfile row, or null if none has been saved yet.
 * Split into queries.ts (rather than merged into actions.ts) to match the
 * project-wide convention used by items, vendors, notes, warranties, and
 * service-records.
 */
export async function getHouseProfile() {
  return prisma.houseProfile.findFirst();
}

/**
 * The house-wide timezone — the single source of truth for all calendar/clock
 * logic. Falls back to `'UTC'` before a profile is saved (matching the column
 * default). Used by server components and worker jobs alike.
 */
export async function getHouseTimezone(): Promise<string> {
  const profile = await prisma.houseProfile.findFirst({ select: { timezone: true } });
  return profile?.timezone ?? HOUSE_DEFAULT_TIMEZONE;
}
