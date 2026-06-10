import { z } from 'zod';
import { HOUSE_DEFAULT_TIMEZONE } from '@/lib/time/timezones';

export const houseProfileSchema = z.object({
  location: z.string().max(200).optional().or(z.literal('')),
  climateZone: z.string().max(50).optional().or(z.literal('')),
  propertyType: z.enum(['single-family', 'townhome', 'condo', 'multi-family', 'other']).optional(),
  // House-wide timezone: the single source of truth for all calendar/clock logic
  // (overdue/due, .ics feed, chore auto-complete, digest content + scheduling,
  // quiet hours). Any valid IANA zone; defaults to UTC.
  timezone: z.string().min(1).max(64).default(HOUSE_DEFAULT_TIMEZONE),
});

export type HouseProfileInput = z.infer<typeof houseProfileSchema>;
