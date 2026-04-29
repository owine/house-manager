import { z } from 'zod';

export const houseProfileSchema = z.object({
  location: z.string().max(200).optional().or(z.literal('')),
  climateZone: z.string().max(50).optional().or(z.literal('')),
  propertyType: z.enum(['single-family', 'townhome', 'condo', 'multi-family', 'other']).optional(),
});

export type HouseProfileInput = z.infer<typeof houseProfileSchema>;
