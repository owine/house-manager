import { z } from 'zod';

// Inline target schema. Task 6 will extract a shared one.
const targetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
  })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.systemId), {
    message: 'exactly one of itemId / systemId must be set',
  });

export const createServiceRecordSchema = z.object({
  targets: z.array(targetSchema).min(1),
  vendorId: z.string().min(1).optional(),
  performedOn: z.coerce.date(),
  cost: z.coerce.number().nonnegative().optional(),
  summary: z.string().min(1, 'Summary is required').max(200),
  notes: z.string().max(20_000).optional(),
});

export const updateServiceRecordSchema = createServiceRecordSchema.partial().extend({
  id: z.string().min(1),
});

export type ServiceRecordTargetInput = z.infer<typeof targetSchema>;
export type CreateServiceRecordInput = z.infer<typeof createServiceRecordSchema>;
export type UpdateServiceRecordInput = z.infer<typeof updateServiceRecordSchema>;
