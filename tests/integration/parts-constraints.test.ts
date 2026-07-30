import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
  todayCal,
} from './helpers';

/**
 * Database-level guarantees for the Part feature. None of this is testable with
 * mocks: `CHECK` constraints and `NULLS NOT DISTINCT` unique indexes only exist
 * in Postgres, and the migration that created them (db38664) carries custom SQL
 * `prisma migrate diff` cannot regenerate.
 *
 * Every rejection asserts on the *constraint name* in the error text. Asserting
 * only "it throws" would keep passing if the CHECK were dropped and some
 * unrelated failure (a missing FK, a NOT NULL) took its place.
 *
 * Inserts go through `$executeRaw` on purpose: Prisma's own P2002 message names
 * the model fields, not the index, so the index name is only observable on the
 * raw Postgres error.
 */

let ctx: IntegrationContext;
let categoryId: string;
let itemId: string;
let systemId: string;

/** A calendar-date literal for raw SQL — `@db.Date` columns are days, not instants. */
const DUE_ON = '2026-08-01';

async function expectRejectionNaming(promise: Promise<unknown>, constraint: string) {
  await expect(promise).rejects.toThrow(new RegExp(constraint));
}

beforeAll(async () => {
  ctx = await setupIntegration();

  const cat = await ctx.prisma.category.upsert({
    where: { slug: 'parts-constraints' },
    create: { slug: 'parts-constraints', name: 'HVAC', sortOrder: 20 },
    update: {},
  });
  categoryId = cat.id;

  const sys = await ctx.prisma.system.create({ data: { name: 'HVAC system' } });
  systemId = sys.id;

  const item = await ctx.prisma.item.create({ data: { name: 'Furnace', categoryId, systemId } });
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  // FK-safe order: join tables, then their parents. Item/System/Category live
  // for the whole suite (created in beforeAll) so they are not truncated here.
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.reminderTarget.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.reminderCompletion.deleteMany();
  await ctx.prisma.reminder.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.part.deleteMany();
});

function createPart(name = 'BR30 dimmable bulb') {
  return ctx.prisma.part.create({ data: { name, kind: 'BULB' } });
}

function createReminder(title: string, kind: 'REMINDER' | 'CHORE' = 'REMINDER') {
  return ctx.prisma.reminder.create({
    data: {
      title,
      kind,
      recurrence: { kind: 'interval', every: 1, unit: 'month' },
      notifyUserIds: [],
    },
  });
}

function createServiceRecord(summary: string) {
  return ctx.prisma.serviceRecord.create({
    data: { summary, performedOn: todayCal() },
  });
}

describe('part_links parent XOR + NULLS NOT DISTINCT unique', () => {
  it('accepts a link to an item', async () => {
    const part = await createPart();
    const link = await ctx.prisma.partLink.create({
      data: { partId: part.id, itemId, quantityInstalled: 6, location: 'Kitchen' },
    });
    expect(link.itemId).toBe(itemId);
    expect(link.systemId).toBeNull();
  });

  it('accepts a link to a system', async () => {
    const part = await createPart();
    const link = await ctx.prisma.partLink.create({
      data: { partId: part.id, systemId },
    });
    expect(link.systemId).toBe(systemId);
    expect(link.itemId).toBeNull();
  });

  it('rejects a link with both an item and a system', async () => {
    const part = await createPart();
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO part_links (id, "partId", "itemId", "systemId")
        VALUES ('pl_both', ${part.id}, ${itemId}, ${systemId})
      `,
      'part_links_parent_xor',
    );
  });

  it('rejects a link with neither an item nor a system', async () => {
    const part = await createPart();
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO part_links (id, "partId", "itemId", "systemId")
        VALUES ('pl_neither', ${part.id}, NULL, NULL)
      `,
      'part_links_parent_xor',
    );
  });

  it('rejects a duplicate (part, item) link — NULLS NOT DISTINCT on the trailing systemId', async () => {
    const part = await createPart();
    await ctx.prisma.partLink.create({ data: { partId: part.id, itemId } });
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO part_links (id, "partId", "itemId", "systemId")
        VALUES ('pl_dupe', ${part.id}, ${itemId}, NULL)
      `,
      'part_links_partId_itemId_systemId_key',
    );
  });

  it('allows a part with zero links (the standalone generic-bulbs case)', async () => {
    const part = await ctx.prisma.part.create({
      data: { name: 'Kitchen can lights', kind: 'BULB', location: 'Kitchen' },
    });
    const links = await ctx.prisma.partLink.findMany({ where: { partId: part.id } });
    expect(links).toHaveLength(0);
  });
});

describe('reminder_targets 3-way "at most one" CHECK', () => {
  it('accepts a part-only target', async () => {
    const part = await createPart();
    const r = await createReminder('Replace bulbs');
    const target = await ctx.prisma.reminderTarget.create({
      data: { reminderId: r.id, partId: part.id, nextDueOn: todayCal() },
    });
    expect(target.partId).toBe(part.id);
    expect(target.itemId).toBeNull();
    expect(target.systemId).toBeNull();
  });

  it('rejects a target with both a part and an item', async () => {
    const part = await createPart();
    const r = await createReminder('Two-parent violation');
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO reminder_targets (id, "reminderId", "itemId", "systemId", "partId", "nextDueOn")
        VALUES ('rt_part_and_item', ${r.id}, ${itemId}, NULL, ${part.id}, CAST(${DUE_ON} AS date))
      `,
      'reminder_targets_parent_at_most_one',
    );
  });

  it('rejects a target with both a part and a system', async () => {
    const part = await createPart();
    const r = await createReminder('Two-parent violation, system flavour');
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO reminder_targets (id, "reminderId", "itemId", "systemId", "partId", "nextDueOn")
        VALUES ('rt_part_and_system', ${r.id}, NULL, ${systemId}, ${part.id}, CAST(${DUE_ON} AS date))
      `,
      'reminder_targets_parent_at_most_one',
    );
  });

  it('STILL accepts the standalone CHORE target with all three parents NULL', async () => {
    // The regression that matters most: generalizing the pairwise CHECK into
    // num_nonnulls(...) could easily have tightened `<= 1` into `= 1`, which
    // would break every unlinked chore (they own a both-NULL row purely to
    // carry cadence + completion history).
    const r = await createReminder('Sweep the porch', 'CHORE');
    const target = await ctx.prisma.reminderTarget.create({
      data: { reminderId: r.id, nextDueOn: todayCal() },
    });
    expect(target.itemId).toBeNull();
    expect(target.systemId).toBeNull();
    expect(target.partId).toBeNull();
  });

  it('STILL rejects a duplicate (reminder, item) target after the unique index was rebuilt with partId', async () => {
    // Proves NULLS NOT DISTINCT survived the DROP INDEX / CREATE UNIQUE INDEX
    // cycle. Under default Postgres semantics the two trailing NULLs would make
    // these rows distinct and the insert would succeed.
    const r = await createReminder('Duplicate target parent');
    await ctx.prisma.reminderTarget.create({
      data: { reminderId: r.id, itemId, nextDueOn: todayCal() },
    });
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO reminder_targets (id, "reminderId", "itemId", "systemId", "partId", "nextDueOn")
        VALUES ('rt_dupe_item', ${r.id}, ${itemId}, NULL, NULL, CAST(${DUE_ON} AS date))
      `,
      'reminder_targets_reminder_item_system_part_key',
    );
  });
});

describe('service_record_targets 3-way "exactly one" CHECK', () => {
  it('accepts a part-only target', async () => {
    const part = await createPart();
    const sr = await createServiceRecord('Swapped the bulbs');
    const target = await ctx.prisma.serviceRecordTarget.create({
      data: { serviceRecordId: sr.id, partId: part.id },
    });
    expect(target.partId).toBe(part.id);
    expect(target.itemId).toBeNull();
    expect(target.systemId).toBeNull();
  });

  it('rejects a target with a part and an item', async () => {
    const part = await createPart();
    const sr = await createServiceRecord('Two-parent violation');
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO service_record_targets (id, "serviceRecordId", "itemId", "systemId", "partId")
        VALUES ('srt_part_and_item', ${sr.id}, ${itemId}, NULL, ${part.id})
      `,
      'service_record_targets_parent_xor',
    );
  });

  it('rejects a target with all three parents NULL — unlike reminder_targets', async () => {
    const sr = await createServiceRecord('Orphan target');
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO service_record_targets (id, "serviceRecordId", "itemId", "systemId", "partId")
        VALUES ('srt_no_parent', ${sr.id}, NULL, NULL, NULL)
      `,
      'service_record_targets_parent_xor',
    );
  });

  it('rejects a duplicate (record, part) target', async () => {
    const part = await createPart();
    const sr = await createServiceRecord('Duplicate target parent');
    await ctx.prisma.serviceRecordTarget.create({
      data: { serviceRecordId: sr.id, partId: part.id },
    });
    await expectRejectionNaming(
      ctx.prisma.$executeRaw`
        INSERT INTO service_record_targets (id, "serviceRecordId", "itemId", "systemId", "partId")
        VALUES ('srt_dupe_part', ${sr.id}, NULL, NULL, ${part.id})
      `,
      'sr_targets_record_item_system_part_key',
    );
  });
});
