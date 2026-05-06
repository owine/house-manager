import { z } from 'zod';

export const SystemCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.string().max(60).optional().nullable(),
  location: z.string().max(120).optional().nullable(),
  installDate: z.coerce.date().optional().nullable(),
  installCost: z.coerce.number().nonnegative().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const SystemUpdateSchema = SystemCreateSchema.partial();

export type SystemCreateInput = z.infer<typeof SystemCreateSchema>;
export type SystemUpdateInput = z.infer<typeof SystemUpdateSchema>;
