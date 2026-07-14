import { Prisma } from '@prisma/client';

/**
 * Write guard for the calendar-date columns.
 *
 * These columns are Postgres `date` (see the calendar_date_columns migration), so
 * a time component is unrepresentable on READ. But a `date` column does NOT
 * reject a bad WRITE: Prisma silently truncates an instant to its **UTC** day.
 * `performedOn: new Date()` at 8pm Chicago stores TOMORROW, with no error.
 *
 * Worse, the column type destroyed the only detector we had. `assertCalendarDate`
 * could previously catch a dirty value on read; now every read is UTC-midnight by
 * construction, so a write-side bug would be invisible in the data -- exactly the
 * property that made the recurrence-drift bugs so hard to find.
 *
 * So the column type and this guard are a pair. Neither is sufficient alone.
 *
 * The rule: a calendar date is a *day*. Reduce the instant to the house day first
 * (`startOfDayUtc(instant, tz)`); do not hand an instant to a date column.
 */

/** Columns that hold a calendar date, keyed by Prisma model name. */
const CALENDAR_DATE_FIELDS: Record<string, readonly string[]> = {
  ReminderTarget: ['nextDueOn'],
  Warranty: ['startsOn', 'endsOn'],
  ServiceRecord: ['performedOn'],
  Item: ['purchaseDate'],
  System: ['installDate'],
  Checklist: ['nextDueOn'],
  ItemVendor: ['contractEndsOn'],
  SystemVendor: ['contractEndsOn'],
};

const DAY_MS = 86_400_000;

/**
 * The Unix epoch is itself UTC midnight, so a UTC-midnight Date is exactly a whole
 * number of days from it. Anything else carries a time component.
 */
function hasTimeComponent(d: Date): boolean {
  return d.getTime() % DAY_MS !== 0;
}

function checkValue(model: string, field: string, raw: unknown): void {
  // Prisma accepts either a bare value or an update-operation wrapper ({ set: … }).
  const value =
    raw instanceof Date ? raw : ((raw as { set?: unknown } | null | undefined)?.set ?? null);
  if (!(value instanceof Date) || !hasTimeComponent(value)) return;

  throw new Error(
    `${model}.${field} is a calendar date (a day), but was written with a time component: ` +
      `${value.toISOString()}. Postgres would silently truncate this to its UTC day, which ` +
      `is the WRONG day for any instant past ~19:00 in a negative-offset timezone. ` +
      `Reduce it to the house day first: startOfDayUtc(instant, tz).`,
  );
}

/**
 * Relation field -> target model, per model, derived from the DMMF so it cannot
 * drift as the schema changes.
 */
const RELATIONS: Record<string, Record<string, string>> = {};
for (const m of Prisma.dmmf.datamodel.models) {
  const rel: Record<string, string> = {};
  for (const f of m.fields) {
    if (f.kind === 'object') rel[f.name] = f.type;
  }
  RELATIONS[m.name] = rel;
}

/** The nested-write operations that carry a payload we must descend into. */
const NESTED_OPS = ['create', 'update', 'upsert', 'connectOrCreate', 'createMany', 'updateMany'];

/**
 * Walk a Prisma write payload, checking calendar-date fields at every level.
 *
 * ⚠️ Descending into nested relations is NOT optional. Checking only the top-level
 * model misses `reminder.create({ data: { targets: { create: [{ nextDueOn }] } } })`
 * -- which is exactly how lib/reminders/actions.ts and lib/ai/suggest/reminders.ts
 * create targets. The first version of this guard checked only the top level and
 * silently let every one of those through.
 */
export function assertCalendarDateWrite(model: string | undefined, data: unknown): void {
  if (!model || data == null || typeof data !== 'object') return;

  const fields = CALENDAR_DATE_FIELDS[model];
  const relations = RELATIONS[model] ?? {};

  for (const row of Array.isArray(data) ? data : [data]) {
    if (row == null || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;

    // 1. This model's own calendar-date columns.
    for (const field of fields ?? []) {
      checkValue(model, field, rec[field]);
    }

    // 2. Nested relation writes -- re-enter with the RELATED model.
    for (const [key, value] of Object.entries(rec)) {
      const relatedModel = relations[key];
      if (!relatedModel || value == null || typeof value !== 'object') continue;

      for (const op of NESTED_OPS) {
        const payload = (value as Record<string, unknown>)[op];
        if (payload == null || typeof payload !== 'object') continue;

        for (const entry of Array.isArray(payload) ? payload : [payload]) {
          if (entry == null || typeof entry !== 'object') continue;
          const e = entry as Record<string, unknown>;
          // `createMany`/`updateMany` wrap rows in `{ data }`; `update` may be
          // `{ where, data }`; `upsert` splits into `{ create, update }`.
          if ('data' in e) assertCalendarDateWrite(relatedModel, e.data);
          if ('create' in e) assertCalendarDateWrite(relatedModel, e.create);
          if ('update' in e) assertCalendarDateWrite(relatedModel, e.update);
          if (!('data' in e) && !('create' in e) && !('update' in e)) {
            assertCalendarDateWrite(relatedModel, e);
          }
        }
      }
    }
  }
}

/**
 * Prisma `query` extension. Note this deliberately does NOT short-circuit in
 * production, unlike `assertCalendarDate` in lib/time/tz.ts. Every write site was
 * fixed before this landed, so a throw in prod means a genuine new bug -- and
 * that is precisely the thing we want to hear about loudly rather than discover
 * six months later as a due date that has quietly walked a week forward.
 */
export const calendarDateWriteGuard = {
  query: {
    $allModels: {
      // biome-ignore lint/suspicious/noExplicitAny: Prisma's $allOperations args are untyped by design.
      async $allOperations({ model, args, query }: any) {
        const a = args as { data?: unknown; create?: unknown; update?: unknown } | undefined;
        if (a?.data !== undefined) assertCalendarDateWrite(model, a.data);
        // upsert carries its payloads under `create` / `update`.
        if (a?.create !== undefined) assertCalendarDateWrite(model, a.create);
        if (a?.update !== undefined) assertCalendarDateWrite(model, a.update);
        return query(args);
      },
    },
  },
} as const;
