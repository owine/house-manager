import { z } from 'zod';

export const createServiceRecordSchema = z.object({
  itemId: z.string().min(1).optional(),
  vendorId: z.string().min(1).optional(),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

export const updateServiceRecordSchema = createServiceRecordSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateServiceRecordInput = z.infer<typeof createServiceRecordSchema>;
export type UpdateServiceRecordInput = z.infer<typeof updateServiceRecordSchema>;
