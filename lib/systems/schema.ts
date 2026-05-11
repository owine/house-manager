import { z } from 'zod';

export const createSystemSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.string().max(60).optional().nullable(),
  location: z.string().max(120).optional().nullable(),
  installDate: z.coerce.date().optional().nullable(),
  installCost: z.coerce.number().nonnegative().optional().nullable(),
  notes: z.string().max(20_000).optional().nullable(),
});

export const updateSystemSchema = createSystemSchema.partial();

export const updateSystemWithIdSchema = createSystemSchema.partial().extend({
  id: z.string().min(1),
});

export type SystemCreateInput = z.infer<typeof createSystemSchema>;
type SystemUpdateInput = z.infer<typeof updateSystemSchema>;
type SystemUpdateWithIdInput = z.infer<typeof updateSystemWithIdSchema>;
