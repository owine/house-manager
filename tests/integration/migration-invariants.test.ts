import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

// Regression test for the hand-edited migration invariants on the multi-target
// and vendor-link tables. Prisma 7.8 cannot model `NULLS NOT DISTINCT` in
// `@@unique`, and the parent/link XOR is enforced by a raw CHECK constraint.
// If anyone regenerates these migrations with `prisma migrate dev` (or
// `db push`) without preserving the raw SQL, the duplicate-rejection /
// exclusivity guarantees would silently disappear. This test introspects the
// live schema produced by `setupIntegration()` (which runs `prisma migrate
// deploy` against a fresh database) and asserts both invariants are present.

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

describe('migration invariants', () => {
  describe('NULLS NOT DISTINCT on target unique indexes', () => {
    const indexNames = [
      'service_record_targets_serviceRecordId_itemId_systemId_key',
      'warranty_targets_warrantyId_itemId_systemId_key',
      'reminder_targets_reminderId_itemId_systemId_key',
    ];

    for (const name of indexNames) {
      it(`${name} uses NULLS NOT DISTINCT`, async () => {
        const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
          SELECT indexdef FROM pg_indexes WHERE indexname = ${name}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].indexdef).toMatch(/NULLS NOT DISTINCT/i);
      });
    }
  });

  describe('XOR CHECK constraints exist', () => {
    const constraints = [
      'service_record_targets_parent_xor',
      'warranty_targets_parent_xor',
      'reminder_targets_parent_xor',
      'item_vendors_link_xor',
      'system_vendors_link_xor',
    ];

    for (const constraint of constraints) {
      it(`${constraint} is present`, async () => {
        const rows = await ctx.prisma.$queryRaw<Array<{ conname: string }>>`
          SELECT conname FROM pg_constraint WHERE conname = ${constraint}
        `;
        expect(rows).toHaveLength(1);
      });
    }
  });
});
