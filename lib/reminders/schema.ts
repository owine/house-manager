import { z } from 'zod';

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

// Inline target schema. Task 6 will extract a shared one (matches the
// inline shape used in lib/warranties/schema.ts and lib/service-records/schema.ts).
const reminderTargetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
  })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.systemId), {
    message: 'exactly one of itemId / systemId must be set',
  });

export const createReminderSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().or(z.literal('')),
  targets: z.array(reminderTargetSchema).min(1),
  recurrence: recurrenceSchema,
  nextDueOn: z.coerce.date(),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  autoCreateServiceRecord: z.boolean().default(false),
  notifyUserIds: z.array(z.string().min(1)).optional(),
});

export type ReminderTargetInput = z.infer<typeof reminderTargetSchema>;
export type CreateReminderInput = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = createReminderSchema.partial().extend({
  id: z.string().min(1),
  active: z.boolean().optional(),
});

export type UpdateReminderInput = z.infer<typeof updateReminderSchema>;

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

export type CompleteReminderInput = z.infer<typeof completeReminderSchema>;
