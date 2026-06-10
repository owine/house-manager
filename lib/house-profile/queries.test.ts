import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type IntegrationContext,
  setupIntegration,
  teardownIntegration,
} from './../../tests/integration/helpers';

let ctx: IntegrationContext;
let getHouseTimezone: () => Promise<string>;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import to avoid the module-load DATABASE_URL trap.
  ({ getHouseTimezone } = await import('./queries'));
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.houseProfile.deleteMany();
});

describe('getHouseTimezone', () => {
  it("falls back to 'UTC' when no HouseProfile row exists", async () => {
    expect(await getHouseTimezone()).toBe('UTC');
  });

  it('returns the saved house timezone', async () => {
    await ctx.prisma.houseProfile.create({ data: { timezone: 'America/Chicago' } });
    expect(await getHouseTimezone()).toBe('America/Chicago');
  });
});
