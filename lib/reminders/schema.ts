import { z } from 'zod';
import { targetsArraySchema } from '@/lib/targets/schema';

export const recurrenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(28),
  }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(28),
  }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;

export const createReminderSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().or(z.literal('')),
  targets: targetsArraySchema,
  recurrence: recurrenceSchema,
  nextDueOn: z.coerce.date(),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  autoCreateServiceRecord: z.boolean().default(false),
  notifyUserIds: z.array(z.string().min(1)).optional(),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = createReminderSchema.partial().extend({
  id: z.string().min(1),
  active: z.boolean().optional(),
});

type UpdateReminderInput = z.infer<typeof updateReminderSchema>;

// Per-target completion. `targetIds` selects which targets to mark complete;
// each one becomes its own ReminderCompletion row and advances its target's
// lastCompletedOn / nextDueOn independently.
export const completeReminderSchema = z.object({
  id: z.string().min(1),
  targetIds: z.array(z.string().min(1)).min(1).optional(),
  notes: z.string().max(20_000).optional().or(z.literal('')),
  serviceRecord: z
    .object({
      summary: z.string().min(1).max(200),
      vendorId: z.string().min(1).optional(),
      cost: z.coerce.number().nonnegative().optional(),
      notes: z.string().max(20_000).optional().or(z.literal('')),
    })
    .optional(),
});

type CompleteReminderInput = z.infer<typeof completeReminderSchema>;
