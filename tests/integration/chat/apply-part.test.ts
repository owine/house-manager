import type { ChatProposalKind, ChatProposalStatus, Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInAs } from '../ai/_mock-auth';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

// Part proposals through the apply pipeline. Split from apply.test.ts because
// the assertions here are about a different concern: the Decimal wire format
// and the parent link, neither of which any other proposal kind has.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/auth', async () => {
  const { currentUserId } = await import('../ai/_mock-auth');
  return {
    auth: vi.fn(async () => {
      const id = currentUserId();
      return id ? { user: { id } } : null;
    }),
  };
});

let ctx: IntegrationContext;
let applyProposal: typeof import('@/lib/chat/actions').applyProposal;
let refreshProposal: typeof import('@/lib/chat/actions').refreshProposal;
let validateProposal: typeof import('@/lib/chat/resolve').validateProposal;

let userId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  // Dynamic import AFTER setupIntegration: lib/db builds its Prisma singleton
  // at import time from process.env.DATABASE_URL.
  ({ applyProposal, refreshProposal } = await import('@/lib/chat/actions'));
  ({ validateProposal } = await import('@/lib/chat/resolve'));
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

async function seed() {
  await ctx.prisma.chatProposal.deleteMany();
  await ctx.prisma.chatMessage.deleteMany();
  await ctx.prisma.chatSession.deleteMany();
  await ctx.prisma.partLink.deleteMany();
  await ctx.prisma.part.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.category.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();

  const u = await ctx.prisma.user.create({ data: { email: 'chat-part@x', name: 'C' } });
  userId = u.id;
  signInAs(userId);

  await ctx.prisma.category.create({ data: { id: 'cat-1', slug: 'fixture', name: 'Fixture' } });
  await ctx.prisma.item.create({ data: { id: 'item-1', name: 'Pendant', categoryId: 'cat-1' } });
  await ctx.prisma.system.create({ data: { id: 'sys-1', name: 'HVAC' } });
}

async function createProposal(opts: {
  kind: ChatProposalKind;
  payload: unknown;
  targetType?: string | null;
  targetId?: string | null;
  baseUpdatedAt?: Date | null;
  beforeSnapshot?: unknown;
  status?: ChatProposalStatus;
}) {
  const chatSession = await ctx.prisma.chatSession.create({
    data: { userId, title: 'Test session' },
  });
  const message = await ctx.prisma.chatMessage.create({
    data: { sessionId: chatSession.id, role: 'ASSISTANT', content: 'test reply' },
  });
  return ctx.prisma.chatProposal.create({
    data: {
      messageId: message.id,
      kind: opts.kind,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      payload: opts.payload as Prisma.InputJsonValue,
      baseUpdatedAt: opts.baseUpdatedAt ?? null,
      beforeSnapshot: (opts.beforeSnapshot as Prisma.InputJsonValue) ?? undefined,
      status: opts.status ?? 'PENDING',
    },
  });
}

function seedPart(over: Partial<Prisma.PartUncheckedCreateInput> = {}) {
  return ctx.prisma.part.create({
    data: {
      id: 'part-1',
      name: 'BR30 dimmable',
      kind: 'BULB',
      typicalCost: '4.50',
      metadata: { base: 'E26', shape: 'BR30' } as Prisma.InputJsonValue,
      ...over,
    },
  });
}

describe('applyProposal — part kinds', () => {
  beforeEach(seed);

  it('applies CREATE_PART: writes the spec to metadata AND the parent link', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_PART',
      targetType: 'PART',
      payload: {
        kind: 'CREATE_PART',
        name: { value: 'BR30 dimmable', source: 'user' },
        partKind: { value: 'BULB', source: 'user' },
        manufacturer: { value: 'Philips', source: 'inferred' },
        typicalCost: { value: '4.50', source: 'user' },
        spec: { value: { base: 'E26', shape: 'BR30', watts: 9 }, source: 'inferred' },
        itemId: 'item-1',
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const part = await ctx.prisma.part.findUniqueOrThrow({
      where: { id: result.data.id },
      include: { links: true },
    });
    expect(part.name).toBe('BR30 dimmable');
    expect(part.kind).toBe('BULB');
    expect(part.manufacturer).toBe('Philips');
    expect(Number(part.typicalCost)).toBe(4.5);

    const metadata = part.metadata as Record<string, unknown>;
    expect(metadata.base).toBe('E26');
    expect(metadata.shape).toBe('BR30');
    expect(metadata.watts).toBe(9);
    // Provenance rides alongside the spec, merged rather than overwriting it.
    expect(metadata._provenance).toEqual({
      name: 'user',
      partKind: 'user',
      manufacturer: 'inferred',
      typicalCost: 'user',
      spec: 'inferred',
    });

    expect(part.links).toHaveLength(1);
    expect(part.links[0]?.itemId).toBe('item-1');
    expect(part.links[0]?.systemId).toBeNull();

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('ACCEPTED');
    expect(updated.appliedEntityId).toBe(part.id);
  });

  it('applies CREATE_PART with no parent (the standalone generic-bulbs case)', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_PART',
      targetType: 'PART',
      payload: {
        kind: 'CREATE_PART',
        name: { value: 'AA batteries', source: 'user' },
        partKind: { value: 'BATTERY', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const part = await ctx.prisma.part.findUniqueOrThrow({
      where: { id: result.data.id },
      include: { links: true },
    });
    expect(part.kind).toBe('BATTERY');
    expect(part.links).toHaveLength(0);
  });

  it('applies UPDATE_PART', async () => {
    const existing = await seedPart();
    const proposal = await createProposal({
      kind: 'UPDATE_PART',
      targetType: 'PART',
      targetId: existing.id,
      baseUpdatedAt: existing.updatedAt,
      payload: {
        kind: 'UPDATE_PART',
        partId: existing.id,
        manufacturer: { value: 'GE', source: 'user' },
        typicalCost: { value: '5.25', source: 'user' },
        spec: { value: { base: 'E26', watts: 9 }, source: 'inferred' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);

    const part = await ctx.prisma.part.findUniqueOrThrow({ where: { id: existing.id } });
    expect(part.manufacturer).toBe('GE');
    expect(Number(part.typicalCost)).toBe(5.25);
    const metadata = part.metadata as Record<string, unknown>;
    expect(metadata.watts).toBe(9);
    expect(metadata._provenance).toEqual({
      manufacturer: 'user',
      typicalCost: 'user',
      spec: 'inferred',
    });
  });

  it('marks UPDATE_PART STALE when baseUpdatedAt no longer matches', async () => {
    const existing = await seedPart();
    const proposal = await createProposal({
      kind: 'UPDATE_PART',
      targetType: 'PART',
      targetId: existing.id,
      baseUpdatedAt: new Date(existing.updatedAt.getTime() - 60_000),
      payload: {
        kind: 'UPDATE_PART',
        partId: existing.id,
        name: { value: 'Renamed', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(false);

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('STALE');
    // The write must NOT have landed.
    const part = await ctx.prisma.part.findUniqueOrThrow({ where: { id: existing.id } });
    expect(part.name).toBe('BR30 dimmable');
  });

  it('marks UPDATE_PART ORPHANED when the part was deleted', async () => {
    const existing = await seedPart();
    const proposal = await createProposal({
      kind: 'UPDATE_PART',
      targetType: 'PART',
      targetId: existing.id,
      baseUpdatedAt: existing.updatedAt,
      payload: {
        kind: 'UPDATE_PART',
        partId: existing.id,
        name: { value: 'Renamed', source: 'user' },
      },
    });
    await ctx.prisma.part.delete({ where: { id: existing.id } });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(false);

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('ORPHANED');
  });
});

describe('captureBeforeState — the Decimal wire format', () => {
  beforeEach(seed);

  // Exercised through refreshProposal, which recomputes baseUpdatedAt +
  // beforeSnapshot from the same read captureBeforeState performs at propose
  // time. Without the toFixed(2) normalisation this returns the string "4.5" —
  // decimal.js defines toJSON, so the naive write does not throw, it just
  // silently drops the trailing zero and diffs against a proposed "4.50".
  it('captures typicalCost as "4.50", not "4.5"', async () => {
    const existing = await seedPart();
    const proposal = await createProposal({
      kind: 'UPDATE_PART',
      targetType: 'PART',
      targetId: existing.id,
      status: 'STALE',
      baseUpdatedAt: new Date(existing.updatedAt.getTime() - 60_000),
      payload: {
        kind: 'UPDATE_PART',
        partId: existing.id,
        typicalCost: { value: '4.50', source: 'user' },
      },
    });

    const result = await refreshProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const snapshot = result.data.proposal.beforeSnapshot as Record<string, unknown>;
    expect(snapshot.typicalCost).toBe('4.50');
    expect(snapshot.typicalCost).not.toBe('4.5');

    // Freshness was genuinely re-armed rather than silently disabled — the
    // `default:` bug would have returned baseUpdatedAt null and ORPHANED the
    // proposal instead.
    expect(result.data.proposal.baseUpdatedAt?.getTime()).toBe(existing.updatedAt.getTime());
    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('PENDING');
  });

  it('scopes the snapshot to the touched fields only', async () => {
    const existing = await seedPart();
    const proposal = await createProposal({
      kind: 'UPDATE_PART',
      targetType: 'PART',
      targetId: existing.id,
      status: 'STALE',
      baseUpdatedAt: new Date(existing.updatedAt.getTime() - 60_000),
      payload: {
        kind: 'UPDATE_PART',
        partId: existing.id,
        name: { value: 'Renamed', source: 'user' },
      },
    });

    const result = await refreshProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.proposal.beforeSnapshot).toEqual({ name: 'BR30 dimmable' });
  });
});

describe('validateProposal — part arms against a real snapshot', () => {
  beforeEach(seed);

  it('rejects a partId absent from the snapshot', async () => {
    await seedPart();
    const result = await validateProposal({ kind: 'UPDATE_PART', partId: 'part-nope' } as never, {
      itemIds: new Set(['item-1']),
      systemIds: new Set(['sys-1']),
      categoryIds: new Set(['cat-1']),
      noteIds: new Set<string>(),
      partIds: new Set(['part-1']),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a spec failing the stored kind schema when partKind is omitted', async () => {
    await seedPart();
    const result = await validateProposal(
      {
        kind: 'UPDATE_PART',
        partId: 'part-1',
        // The stored kind is BULB, whose `watts` is a number.
        spec: { value: { watts: 'nine' }, source: 'inferred' },
      } as never,
      {
        itemIds: new Set(['item-1']),
        systemIds: new Set(['sys-1']),
        categoryIds: new Set(['cat-1']),
        noteIds: new Set<string>(),
        partIds: new Set(['part-1']),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/spec/);
  });
});
