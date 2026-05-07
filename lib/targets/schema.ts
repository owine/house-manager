import { z } from 'zod';

export const targetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
  })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.systemId), {
    message: 'exactly one of itemId / systemId must be set',
  });

export const targetsArraySchema = z.array(targetSchema).min(1);

export type TargetInput = z.infer<typeof targetSchema>;
