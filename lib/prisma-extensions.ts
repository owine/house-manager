import type { PrismaClient } from '@prisma/client';
import { calendarDateWriteGuard } from './calendar-date-guard';
import { asCalendarDate, type CalendarDate } from './time/tz';

/**
 * Prisma client extensions, in one place.
 *
 * This module is deliberately a LEAF: it instantiates nothing and reads no env.
 * `lib/db.ts` builds a client at module load from `process.env.DATABASE_URL`, so
 * importing *that* from the integration harness would construct the singleton
 * before the harness has pointed DATABASE_URL at the test container -- the
 * module-load DATABASE_URL trap (see the note in lib/digests/queries.test.ts).
 * Both the real client and the test harness import from here instead.
 */

/** Brand a nullable `date` column on read. */
const brandNullable = (d: Date | null): CalendarDate | null => (d ? asCalendarDate(d) : null);

export function applyPrismaExtensions(client: PrismaClient) {
  return (
    client
      // The calendar-date columns are Postgres `date`, so a time component cannot
      // survive a read -- but Prisma will silently TRUNCATE one on write, storing
      // the wrong day. The guard makes that throw. See lib/calendar-date-guard.ts.
      .$extends(calendarDateWriteGuard)
      // Brand those columns as CalendarDate on the way out, once, here. The type
      // then flows from the database into the app, instead of being re-asserted
      // (or forgotten) at every one of ~30 read sites.
      .$extends({
        result: {
          reminderTarget: {
            nextDueOn: {
              needs: { nextDueOn: true },
              compute: ({ nextDueOn }) => asCalendarDate(nextDueOn),
            },
          },
          warranty: {
            startsOn: {
              needs: { startsOn: true },
              compute: ({ startsOn }) => asCalendarDate(startsOn),
            },
            endsOn: { needs: { endsOn: true }, compute: ({ endsOn }) => asCalendarDate(endsOn) },
          },
          serviceRecord: {
            performedOn: {
              needs: { performedOn: true },
              compute: ({ performedOn }) => asCalendarDate(performedOn),
            },
          },
          item: {
            purchaseDate: {
              needs: { purchaseDate: true },
              compute: ({ purchaseDate }) => brandNullable(purchaseDate),
            },
          },
          system: {
            installDate: {
              needs: { installDate: true },
              compute: ({ installDate }) => brandNullable(installDate),
            },
          },
          checklist: {
            nextDueOn: {
              needs: { nextDueOn: true },
              compute: ({ nextDueOn }) => brandNullable(nextDueOn),
            },
          },
          itemVendor: {
            contractEndsOn: {
              needs: { contractEndsOn: true },
              compute: ({ contractEndsOn }) => brandNullable(contractEndsOn),
            },
          },
          systemVendor: {
            contractEndsOn: {
              needs: { contractEndsOn: true },
              compute: ({ contractEndsOn }) => brandNullable(contractEndsOn),
            },
          },
        },
      })
  );
}
