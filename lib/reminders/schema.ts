import { z } from 'zod';
import { targetsArraySchema } from '@/lib/targets/schema';

const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .refine((a) => new Set(a).size === a.length, { message: 'weekdays must be unique' });

const activeMonthsSchema = z
  .array(z.number().int().min(1).max(12))
  .min(1)
  .refine((a) => new Set(a).size === a.length, { message: 'activeMonths must be unique' });

// `activeMonths` (optional) restricts a recurrence to a set of calendar months
// (seasonality). Omitted = year-round. Applied uniformly across recurring kinds.
const seasonal = { activeMonths: activeMonthsSchema.optional() };

export const recurrenceSchema = z.discriminatedUnion('kind', [
  // interval — anchored to LAST COMPLETION; unit-based, calendar-aware.
  z.object({
    kind: z.literal('interval'),
    every: z.number().int().min(1).max(3650),
    unit: z.enum(['day', 'week', 'month', 'year']),
    ...seasonal,
  }),
  // weekly — one or more weekdays (0=Sun..6=Sat), calendar-anchored.
  z.object({ kind: z.literal('weekly'), weekdays: weekdaysSchema, ...seasonal }),
  // monthly — fixed day-of-month, or 'last' for the final day of each month.
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: z.union([z.number().int().min(1).max(28), z.literal('last')]),
    ...seasonal,
  }),
  // monthlyWeekday — nth weekday (week: 1..4 or -1 for last; weekday 0=Sun..6=Sat).
  z.object({
    kind: z.literal('monthlyWeekday'),
    week: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
    weekday: z.number().int().min(0).max(6),
    ...seasonal,
  }),
  // yearly intentionally omits `activeMonths`: a once-a-year recurrence is
  // already pinned to a single month, so seasonality is degenerate. Keeping it
  // off the variant ensures schema, computeNextDueOn, and describeRecurrence
  // agree (no season suffix can appear on a yearly recurrence).
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(28),
  }),
  // `once` fires exactly once on the target's `nextDueOn` and never again.
  // Used for one-shot reminders (e.g. a warranty expiry). After firing, the
  // existing NotificationLog dedupe prevents re-fires for the same cycle key.
  z.object({ kind: z.literal('once') }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;

/**
 * Normalize a stored recurrence JSON value into the current `Recurrence` shape,
 * then validate. Recurrence is read from the DB as opaque Json and historically
 * cast (not parsed); the legacy `interval {days:N}` shape predates unit-based
 * intervals, so map it to `{every:N, unit:'day'}` before validating. Throws on
 * anything that isn't a known shape.
 */
export function parseRecurrence(json: unknown): Recurrence {
  let candidate = json;
  if (
    json !== null &&
    typeof json === 'object' &&
    (json as { kind?: unknown }).kind === 'interval' &&
    typeof (json as { days?: unknown }).days === 'number' &&
    (json as { every?: unknown }).every === undefined
  ) {
    const { days, ...rest } = json as { days: number; [k: string]: unknown };
    candidate = { ...rest, every: days, unit: 'day' };
  }
  return recurrenceSchema.parse(candidate);
}

// One model, two views: REMINDER is calendar-tied with notifications;
// CHORE is the ambient-cadence cousin (no notifications fire — the
// reminders-tick worker filters them out — but they still live in the
// same table with the same recurrence + targets shape).
//
// Values match the Prisma `ReminderKind` enum verbatim so passthrough
// to the DB needs no remapping.
const reminderKindSchema = z.enum(['REMINDER', 'CHORE']);

export const createReminderSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().or(z.literal('')),
  targets: targetsArraySchema,
  recurrence: recurrenceSchema,
  nextDueOn: z.coerce.date(),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  autoCreateServiceRecord: z.boolean().default(false),
  notifyUserIds: z.array(z.string().min(1)).optional(),
  kind: reminderKindSchema.default('REMINDER'),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = createReminderSchema.partial().extend({
  id: z.string().min(1),
  active: z.boolean().optional(),
  // Override the `.default('REMINDER')` from createReminderSchema so an
  // update that omits `kind` doesn't silently flip a CHORE back to REMINDER.
  kind: reminderKindSchema.optional(),
});

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
