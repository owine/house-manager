import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.houseProfile.deleteMany();
});

describe('HouseProfile singleton CRUD', () => {
  it('returns null when no profile exists', async () => {
    const profile = await ctx.prisma.houseProfile.findFirst();
    expect(profile).toBeNull();
  });

  it('creates a row on first save', async () => {
    const saved = await ctx.prisma.houseProfile.create({
      data: { location: 'San Diego', climateZone: '3B', propertyType: 'single-family' },
    });
    expect(saved.id).toBeTruthy();
    expect(saved.location).toBe('San Diego');
    expect(saved.climateZone).toBe('3B');
    expect(saved.propertyType).toBe('single-family');

    const count = await ctx.prisma.houseProfile.count();
    expect(count).toBe(1);
  });

  it('updates the same row on second save (singleton remains)', async () => {
    const first = await ctx.prisma.houseProfile.create({
      data: { location: 'San Diego' },
    });

    const existing = await ctx.prisma.houseProfile.findFirst();
    if (!existing) throw new Error('Expected a profile row to exist');

    await ctx.prisma.houseProfile.update({
      where: { id: existing.id },
      data: { location: 'Boston' },
    });

    const count = await ctx.prisma.houseProfile.count();
    expect(count).toBe(1);

    const updated = await ctx.prisma.houseProfile.findFirst();
    expect(updated?.id).toBe(first.id);
    expect(updated?.location).toBe('Boston');
  });

  it('persists NULL for empty string input (emptyToNull convention)', async () => {
    // Simulate the action's emptyToNull mapping: '' becomes null before Prisma write.
    const locationInput = '';
    const saved = await ctx.prisma.houseProfile.create({
      data: { location: locationInput || null },
    });
    expect(saved.location).toBeNull();
  });

  it('clears a field to NULL on update when empty string is provided', async () => {
    await ctx.prisma.houseProfile.create({ data: { location: 'Denver' } });

    const existing = await ctx.prisma.houseProfile.findFirst();
    if (!existing) throw new Error('Expected a profile row to exist');

    // Simulate the action's emptyToNull mapping: a form input of '' becomes null.
    const locationInput: string = '';
    await ctx.prisma.houseProfile.update({
      where: { id: existing.id },
      data: { location: locationInput || null },
    });

    const updated = await ctx.prisma.houseProfile.findFirst();
    expect(updated?.location).toBeNull();
  });
});
