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

const warrantyBase = z.object({
  targets: z.array(targetSchema).min(1),
  provider: z.string().min(1, 'Provider is required').max(200),
  policyNumber: z.string().max(200).optional(),
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date(),
  coverage: z.string().max(20_000).optional(),
  cost: z.coerce.number().nonnegative().optional(),
});

export const createWarrantySchema = warrantyBase.refine((data) => data.endsOn >= data.startsOn, {
  message: 'End date must be on or after start date',
  path: ['endsOn'],
});

export const updateWarrantySchema = warrantyBase
  .partial()
  .extend({ id: z.string().min(1) })
  .refine(
    (data) => {
      if (data.endsOn !== undefined && data.startsOn !== undefined) {
        return data.endsOn >= data.startsOn;
      }
      return true;
    },
    {
      message: 'End date must be on or after start date',
      path: ['endsOn'],
    },
  );

export type WarrantyTargetInput = z.infer<typeof targetSchema>;
export type CreateWarrantyInput = z.infer<typeof createWarrantySchema>;
export type UpdateWarrantyInput = z.infer<typeof updateWarrantySchema>;
