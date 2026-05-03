import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

describe('buildSuggestContext', () => {
  let ctx: IntegrationContext;
  let categoryId: string;
  let buildSuggestContext: typeof import('@/lib/ai/context-builder').buildSuggestContext;

  beforeAll(async () => {
    ctx = await setupIntegration();
    ({ buildSuggestContext } = await import('@/lib/ai/context-builder'));
    const cat = await ctx.prisma.category.upsert({
      where: { slug: 'hvac' },
      create: { slug: 'hvac', name: 'HVAC', sortOrder: 20 },
      update: {},
    });
    categoryId = cat.id;
  }, 180_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  beforeEach(async () => {
    await ctx.prisma.item.deleteMany();
    await ctx.prisma.houseProfile.deleteMany();
  });

  it('returns inventory filtered to non-archived, includeInSuggestions=true items', async () => {
    await ctx.prisma.item.createMany({
      data: [
        { name: 'Active include', categoryId, includeInSuggestions: true },
        { name: 'Active exclude', categoryId, includeInSuggestions: false },
        {
          name: 'Archived include',
          categoryId,
          includeInSuggestions: true,
          archivedAt: new Date(),
        },
      ],
    });
    const result = await buildSuggestContext({ today: new Date('2026-04-15') });
    expect(result.inventory.map((i) => i.name).sort()).toEqual(['Active include']);
    expect(result.inventorySnapshotIds).toHaveLength(1);
  });

  it('returns null profile when none exists; populated when present', async () => {
    let result = await buildSuggestContext({ today: new Date('2026-04-15') });
    expect(result.profile).toBeNull();
    await ctx.prisma.houseProfile.create({
      data: { location: 'Austin, TX', climateZone: '2A', propertyType: 'Single-family' },
    });
    result = await buildSuggestContext({ today: new Date('2026-04-15') });
    expect(result.profile).toEqual({
      location: 'Austin, TX',
      climateZone: '2A',
      propertyType: 'Single-family',
    });
  });

  it('passes through null fields from a partial profile without coercing to empty string', async () => {
    await ctx.prisma.houseProfile.create({
      data: { location: 'Austin, TX' }, // climateZone and propertyType default to null
    });
    const result = await buildSuggestContext({ today: new Date('2026-04-15') });
    expect(result.profile).toEqual({
      location: 'Austin, TX',
      climateZone: null,
      propertyType: null,
    });
  });

  it('focuses on a single item when itemId is provided', async () => {
    const focused = await ctx.prisma.item.create({
      data: { name: 'Focused furnace', categoryId, manufacturer: 'Carrier', model: '58STA' },
    });
    await ctx.prisma.item.create({ data: { name: 'Other thing', categoryId } });
    const result = await buildSuggestContext({
      today: new Date('2026-04-15'),
      focusedItemId: focused.id,
    });
    expect(result.focusedItem?.id).toBe(focused.id);
    expect(result.focusedItem?.manufacturer).toBe('Carrier');
    expect(result.inventory.length).toBeGreaterThanOrEqual(2);
  });
});
