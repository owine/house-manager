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

/** Walk a Prisma `data` / `create` / `update` payload (object or array). */
export function assertCalendarDateWrite(model: string | undefined, data: unknown): void {
  if (!model || data == null || typeof data !== 'object') return;
  const fields = CALENDAR_DATE_FIELDS[model];
  if (!fields) return;

  for (const row of Array.isArray(data) ? data : [data]) {
    if (row == null || typeof row !== 'object') continue;
    for (const field of fields) {
      checkValue(model, field, (row as Record<string, unknown>)[field]);
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
