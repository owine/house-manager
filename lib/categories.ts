import { z } from 'zod';

const freeformMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const categoryMetadataSchemas: Record<string, z.ZodTypeAny> = {
  appliance: z.object({
    btu: z.number().nonnegative().optional(),
    capacity: z.string().optional(),
    fuelType: z.enum(['electric', 'gas', 'propane', 'oil']).optional(),
  }),
  hvac: z.object({
    btu: z.number().nonnegative().optional(),
    seer: z.number().positive().optional(),
    fuelType: z.enum(['electric', 'gas', 'propane', 'oil', 'heat-pump']).optional(),
    filterSize: z.string().optional(),
  }),
  plumbing: z.object({
    capacityGallons: z.number().nonnegative().optional(),
    fuelType: z.enum(['electric', 'gas']).optional(),
  }),
  electrical: z.object({
    panelBrand: z.string().optional(),
    amps: z.number().positive().optional(),
  }),
  exterior: z.object({
    material: z.string().optional(),
    squareFootage: z.number().nonnegative().optional(),
  }),
  vehicle: z.object({
    vin: z.string().length(17).optional(),
    licensePlate: z.string().optional(),
    mileage: z.number().nonnegative().optional(),
    fuelType: z.enum(['gasoline', 'diesel', 'electric', 'hybrid']).optional(),
  }),
  tool: z.object({
    powerSource: z.enum(['battery', 'corded', 'gas', 'manual']).optional(),
    voltage: z.number().positive().optional(),
  }),
  landscaping: z.object({
    type: z.string().optional(),
    coverageArea: z.string().optional(),
  }),
  other: freeformMetadataSchema,
};

export function metadataSchemaFor(slug: string): z.ZodTypeAny {
  return categoryMetadataSchemas[slug] ?? freeformMetadataSchema;
}
