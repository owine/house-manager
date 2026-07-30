import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IntegrationContext, setupIntegration, teardownIntegration } from './helpers';

let currentUserId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => (currentUserId ? { user: { id: currentUserId } } : null)),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let ctx: IntegrationContext;
let actions: typeof import('@/lib/systems/actions');

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton
  // at import time from process.env.DATABASE_URL.
  actions = await import('@/lib/systems/actions');
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

beforeEach(async () => {
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();
  await ctx.prisma.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'U1' } });
  currentUserId = 'u1';
});

async function makeSystem(name: string) {
  return ctx.prisma.system.create({ data: { name } });
}

async function makePart(name: string) {
  return ctx.prisma.part.create({ data: { name, kind: 'OTHER' } });
}

describe('tryDeleteSystem', () => {
  it('deletes outright when the system has no parts', async () => {
    const system = await makeSystem('Empty system');

    const result = await actions.tryDeleteSystem(system.id);

    expect(result).toEqual({ ok: true });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).toBeNull();
  });

  it('returns the part list with willBeOrphaned per part instead of deleting', async () => {
    const system = await makeSystem('HVAC');
    const other = await makeSystem('Attic');
    const onlyHere = await makePart('Furnace filter');
    const alsoElsewhere = await makePart('BR30 bulb');

    await ctx.prisma.partLink.create({ data: { partId: onlyHere.id, systemId: system.id } });
    await ctx.prisma.partLink.create({ data: { partId: alsoElsewhere.id, systemId: system.id } });
    await ctx.prisma.partLink.create({ data: { partId: alsoElsewhere.id, systemId: other.id } });

    const result = await actions.tryDeleteSystem(system.id);

    expect(result.ok).toBe(false);
    if (result.ok || !('hasParts' in result)) throw new Error('expected the parts prompt');
    expect(result.parts).toEqual([
      { id: alsoElsewhere.id, name: 'BR30 bulb', kind: 'OTHER', willBeOrphaned: false },
      { id: onlyHere.id, name: 'Furnace filter', kind: 'OTHER', willBeOrphaned: true },
    ]);
    // Nothing was deleted — the prompt is a pre-query, not a probe.
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
  });
});

describe('deleteSystemWithParts', () => {
  it('archives exactly the checked set, unlinks the rest, and deletes the system', async () => {
    const system = await makeSystem('HVAC');
    const other = await makeSystem('Attic');
    const archiveMe = await makePart('Furnace filter');
    const keepMe = await makePart('BR30 bulb');

    await ctx.prisma.partLink.create({ data: { partId: archiveMe.id, systemId: system.id } });
    await ctx.prisma.partLink.create({ data: { partId: keepMe.id, systemId: system.id } });
    await ctx.prisma.partLink.create({ data: { partId: keepMe.id, systemId: other.id } });

    const result = await actions.deleteSystemWithParts({
      systemId: system.id,
      archivePartIds: [archiveMe.id],
      keepPartIds: [keepMe.id],
    });

    expect(result).toEqual({ ok: true, data: { archivedCount: 1, keptCount: 1 } });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).toBeNull();
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: archiveMe.id } })).archivedAt,
    ).not.toBeNull();
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: keepMe.id } })).archivedAt,
    ).toBeNull();
    // The kept part keeps its other parent and loses only the link to the
    // deleted system.
    const remaining = await ctx.prisma.partLink.findMany({ where: { partId: keepMe.id } });
    expect(remaining.map((l) => l.systemId)).toEqual([other.id]);
    expect(await ctx.prisma.partLink.count({ where: { systemId: system.id } })).toBe(0);
  });

  it('rolls back and returns the fresh list when a part is linked inside the window', async () => {
    const system = await makeSystem('HVAC');
    const shown = await makePart('Furnace filter');
    await ctx.prisma.partLink.create({ data: { partId: shown.id, systemId: system.id } });

    // 1. The user opens the prompt.
    const prompt = await actions.tryDeleteSystem(system.id);
    if (prompt.ok || !('hasParts' in prompt)) throw new Error('expected the parts prompt');
    const archivePartIds = prompt.parts.filter((p) => p.willBeOrphaned).map((p) => p.id);
    const keepPartIds = prompt.parts.filter((p) => !p.willBeOrphaned).map((p) => p.id);

    // 2. Inside the window — another session (or the phone in the garage)
    //    links a second part to this very system. The dialog on screen has
    //    never heard of it.
    const late = await makePart('Blower belt');
    await ctx.prisma.partLink.create({ data: { partId: late.id, systemId: system.id } });

    // 3. The user submits the stale decision.
    const result = await actions.deleteSystemWithParts({
      systemId: system.id,
      archivePartIds,
      keepPartIds,
    });

    // The whole transaction rolled back...
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
    expect(await ctx.prisma.partLink.count({ where: { systemId: system.id } })).toBe(2);
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: shown.id } })).archivedAt,
    ).toBeNull();
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: late.id } })).archivedAt,
    ).toBeNull();

    // ...and the caller got the fresh list to re-render.
    expect(result.ok).toBe(false);
    if (result.ok || !('hasParts' in result)) throw new Error('expected the stale-parts response');
    expect(result.parts.map((p) => p.id).sort()).toEqual([late.id, shown.id].sort());
    expect(result.parts.every((p) => p.willBeOrphaned)).toBe(true);
  });

  it('rolls back when a part shown in the prompt was unlinked inside the window', async () => {
    const system = await makeSystem('HVAC');
    const shown = await makePart('Furnace filter');
    const vanishing = await makePart('BR30 bulb');
    await ctx.prisma.partLink.create({ data: { partId: shown.id, systemId: system.id } });
    const doomed = await ctx.prisma.partLink.create({
      data: { partId: vanishing.id, systemId: system.id },
    });

    const prompt = await actions.tryDeleteSystem(system.id);
    if (prompt.ok || !('hasParts' in prompt)) throw new Error('expected the parts prompt');

    await ctx.prisma.partLink.delete({ where: { id: doomed.id } });

    const result = await actions.deleteSystemWithParts({
      systemId: system.id,
      archivePartIds: prompt.parts.map((p) => p.id),
      keepPartIds: [],
    });

    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
    expect(
      (await ctx.prisma.part.findUniqueOrThrow({ where: { id: vanishing.id } })).archivedAt,
    ).toBeNull();
    expect(result.ok).toBe(false);
    if (result.ok || !('hasParts' in result)) throw new Error('expected the stale-parts response');
    expect(result.parts.map((p) => p.id)).toEqual([shown.id]);
  });

  it('refuses to act for a signed-out caller', async () => {
    const system = await makeSystem('HVAC');
    currentUserId = null;

    expect(await actions.tryDeleteSystem(system.id)).toEqual({
      ok: false,
      formError: 'Unauthorized',
    });
    expect(
      await actions.deleteSystemWithParts({
        systemId: system.id,
        archivePartIds: [],
        keepPartIds: [],
      }),
    ).toEqual({ ok: false, formError: 'Unauthorized' });
    expect(await ctx.prisma.system.findUnique({ where: { id: system.id } })).not.toBeNull();
  });
});
