import { z } from 'zod';
import { targetSchema } from '@/lib/targets/schema';

function partialOf<T extends Record<string, z.ZodTypeAny>>(shape: T) {
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof T]: z.ZodOptional<T[K]>;
  };
}

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

const nthWeekSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(-1),
]);

const monthDaySchema = z.object({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});

export const recurrenceSchema = z.discriminatedUnion('kind', [
  // interval — anchored to LAST COMPLETION; unit-based, calendar-aware.
  z.object({
    kind: z.literal('interval'),
    every: z.number().int().min(1).max(3650),
    unit: z.enum(['day', 'week', 'month', 'year']),
    ...seasonal,
  }),
  // weekly — one or more weekdays (0=Sun..6=Sat), every `interval` weeks
  // (bi-weekly = 2), optionally anchored to a YYYY-MM-DD week start.
  z.object({
    kind: z.literal('weekly'),
    weekdays: weekdaysSchema,
    interval: z.number().int().min(1).max(52),
    anchor: z.string().date().optional(),
    ...seasonal,
  }),
  // monthly — one or more fixed days-of-month and/or the final day (`last`).
  z
    .object({
      kind: z.literal('monthly'),
      days: z
        .array(z.number().int().min(1).max(28))
        .refine((a) => new Set(a).size === a.length, { message: 'days must be unique' }),
      last: z.boolean(),
      ...seasonal,
    })
    .refine((r) => r.days.length > 0 || r.last, {
      message: 'monthly needs at least one day or last-of-month',
    }),
  // monthlyWeekday — one or more nth-weekday combos (week: 1..4 or -1 for last;
  // weekday 0=Sun..6=Sat), e.g. first & third Monday.
  z.object({
    kind: z.literal('monthlyWeekday'),
    combos: z
      .array(z.object({ week: nthWeekSchema, weekday: z.number().int().min(0).max(6) }))
      .min(1)
      .refine((a) => new Set(a.map((c) => `${c.week}:${c.weekday}`)).size === a.length, {
        message: 'combos must be unique',
      }),
    ...seasonal,
  }),
  // yearly intentionally omits `activeMonths`: each date is already pinned to a
  // single month, so seasonality is degenerate. Keeping it off the variant
  // ensures schema, computeNextDueOn, and describeRecurrence agree (no season
  // suffix can appear on a yearly recurrence). Supports multiple month/day
  // dates (e.g. twice a year).
  z.object({
    kind: z.literal('yearly'),
    dates: z
      .array(monthDaySchema)
      .min(1)
      .refine((a) => new Set(a.map((d) => `${d.month}:${d.day}`)).size === a.length, {
        message: 'dates must be unique',
      }),
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
  let candidate = json as Record<string, unknown> | null;
  if (candidate && typeof candidate === 'object') {
    const k = candidate.kind;
    if (k === 'interval' && typeof candidate.days === 'number' && candidate.every === undefined) {
      const { days, ...rest } = candidate;
      candidate = { ...rest, every: days, unit: 'day' };
    } else if (k === 'weekly' && candidate.interval === undefined) {
      candidate = { ...candidate, interval: 1 };
    } else if (
      k === 'monthly' &&
      candidate.dayOfMonth !== undefined &&
      candidate.days === undefined
    ) {
      const { dayOfMonth, ...rest } = candidate;
      candidate =
        dayOfMonth === 'last'
          ? { ...rest, days: [], last: true }
          : { ...rest, days: [dayOfMonth], last: false };
    } else if (k === 'monthlyWeekday' && candidate.combos === undefined) {
      const { week, weekday, ...rest } = candidate;
      candidate = { ...rest, combos: [{ week, weekday }] };
    } else if (k === 'yearly' && candidate.dates === undefined) {
      const { month, day, ...rest } = candidate;
      candidate = { ...rest, dates: [{ month, day }] };
    }
  }
  return recurrenceSchema.parse(candidate);
}

// One model, two views: REMINDER is calendar-tied with notifications;
// CHORE is the ambient-cadence cousin (no notifications fire — the
// reminders-tick worker filters them out — but they still live in the
// same table with the same recurrence + targets shape).
//
// Values match the Prisma `ReminderKind` enum verbatim so passthrough
// to the DB needs no remapping. The literals are inlined directly into
// each discriminated-union arm below.

// Reminder-specific cardinality. Reminders require ≥1 item/system link
// (asset-centric, notify). Chores may have 0..N links (task-centric;
// a linkless chore gets a "standalone" ReminderTarget row created
// server-side — see lib/reminders/actions.ts reconciliation).
const remindersTargetsSchema = z.array(targetSchema).min(1);
const choresTargetsSchema = z.array(targetSchema);

const baseReminderShape = {
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().or(z.literal('')),
  recurrence: recurrenceSchema,
  nextDueOn: z.coerce.date(),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  autoCreateServiceRecord: z.boolean().default(false),
  autoComplete: z.boolean().default(false),
  notifyUserIds: z.array(z.string().min(1)).optional(),
} as const;

// Discriminated union on `kind`. The discriminator can't carry a default,
// so callers MUST pass `kind` explicitly (was: `.default('REMINDER')`).
export const createReminderSchema = z.discriminatedUnion('kind', [
  z.object({
    ...baseReminderShape,
    kind: z.literal('REMINDER'),
    targets: remindersTargetsSchema,
  }),
  z.object({
    ...baseReminderShape,
    kind: z.literal('CHORE'),
    targets: choresTargetsSchema,
  }),
]);

export type CreateReminderInput = z.infer<typeof createReminderSchema>;

// 3-variant union for updates: explicit REMINDER, explicit CHORE, or
// kind-omitted (no kind change, no targets-cardinality opinion). The
// `kind: undefined` arm keeps existing callers working that patch
// fields without touching kind.
export const updateReminderSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('REMINDER'),
    targets: remindersTargetsSchema.optional(),
    active: z.boolean().optional(),
    ...partialOf(baseReminderShape),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('CHORE'),
    targets: choresTargetsSchema.optional(),
    active: z.boolean().optional(),
    ...partialOf(baseReminderShape),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.undefined().optional(),
    targets: z.undefined().optional(),
    active: z.boolean().optional(),
    ...partialOf(baseReminderShape),
  }),
]);

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
