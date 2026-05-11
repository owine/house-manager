import { z } from 'zod';
import { targetsArraySchema } from '@/lib/targets/schema';

const warrantyBase = z.object({
  targets: targetsArraySchema,
  provider: z.string().min(1, 'Provider is required').max(200),
  policyNumber: z.string().max(200).optional(),
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date(),
  coverage: z.string().max(20_000).optional(),
  cost: z.coerce.number().nonnegative().optional(),
  // Auto-create a `kind:'once'` Reminder firing N days before endsOn.
  // Defaults are biased toward "on" so the user gets a heads-up for free.
  // Edits to the warranty don't sync the reminder — the user can edit /
  // delete the reminder independently after creation.
  createExpiryReminder: z.boolean().default(true),
  expiryReminderLeadDays: z.number().int().min(0).max(365).default(30),
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

export type CreateWarrantyInput = z.infer<typeof createWarrantySchema>;
