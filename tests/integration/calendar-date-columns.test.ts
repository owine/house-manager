import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

let ctx: IntegrationContext;
let itemId: string;

/** 20:00 CDT on Jul 14 -- already Jul 15 in UTC. */
const EVENING_IN_CHICAGO = new Date('2026-07-15T01:00:00Z');
const cal = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.item.deleteMany();
  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'cal-date-cols' },
    create: { slug: 'cal-date-cols', name: 'CDC', sortOrder: 97 },
    update: {},
  });
  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId: cat.id } });
  itemId = item.id;
});

describe('calendar-date columns are Postgres `date`', () => {
  it('reads back at UTC midnight', async () => {
    await ctx.prisma.serviceRecord.create({
      data: { performedOn: cal(2026, 7, 14), summary: 'x' },
    });
    const sr = await ctx.prisma.serviceRecord.findFirstOrThrow();
    expect(sr.performedOn.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('supports UTC-midnight range filters without off-by-one', async () => {
    for (const d of [cal(2026, 7, 13), cal(2026, 7, 14), cal(2026, 7, 15)]) {
      await ctx.prisma.serviceRecord.create({
        data: { performedOn: d, summary: d.toISOString().slice(0, 10) },
      });
    }
    // Inclusive of both endpoints -- the shape /service uses.
    const rows = await ctx.prisma.serviceRecord.findMany({
      where: { performedOn: { gte: cal(2026, 7, 13), lte: cal(2026, 7, 14) } },
      orderBy: { performedOn: 'asc' },
    });
    expect(rows.map((r) => r.summary)).toEqual(['2026-07-13', '2026-07-14']);
  });
});

describe('the write guard', () => {
  // A `date` column does NOT reject a bad write -- Prisma silently truncates an
  // instant to its UTC day. `performedOn: new Date()` at 8pm Chicago would store
  // TOMORROW, with no error, and because every read is now UTC-midnight by
  // construction there would be nothing left to detect it. The guard is what
  // makes the column type safe.
  it('rejects an instant written to a calendar-date column', async () => {
    await expect(
      ctx.prisma.serviceRecord.create({
        data: { performedOn: EVENING_IN_CHICAGO, summary: 'should not persist' },
      }),
    ).rejects.toThrow(/ServiceRecord\.performedOn is a calendar date/);

    expect(await ctx.prisma.serviceRecord.count()).toBe(0);
  });

  it('rejects an instant on update, not just create', async () => {
    const sr = await ctx.prisma.serviceRecord.create({
      data: { performedOn: todayCal(), summary: 'y' },
    });
    await expect(
      ctx.prisma.serviceRecord.update({
        where: { id: sr.id },
        data: { performedOn: EVENING_IN_CHICAGO },
      }),
    ).rejects.toThrow(/calendar date/);
  });

  it('rejects an instant nested in a createMany', async () => {
    const r = await ctx.prisma.reminder.create({
      data: { title: 'r', recurrence: { kind: 'NONE' }, notifyUserIds: [] },
    });
    await expect(
      ctx.prisma.reminderTarget.createMany({
        data: [
          { reminderId: r.id, itemId, nextDueOn: todayCal() },
          { reminderId: r.id, itemId, nextDueOn: EVENING_IN_CHICAGO },
        ],
      }),
    ).rejects.toThrow(/ReminderTarget\.nextDueOn/);
  });

  it('still allows instants on genuine instant columns', async () => {
    // `completedAt` on ChecklistItem is a real instant and must not be caught.
    const cl = await ctx.prisma.checklist.create({ data: { name: 'c' } });
    await expect(
      ctx.prisma.checklistItem.create({
        data: { checklistId: cl.id, position: 1, title: 't', completedAt: EVENING_IN_CHICAGO },
      }),
    ).resolves.toBeTruthy();
  });
});
