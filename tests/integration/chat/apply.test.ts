import type { ChatProposalKind, ChatProposalStatus, Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueItemRenameCascade } from '@/lib/embedding/cascade';
import { signInAs } from '../ai/_mock-auth';
import { type IntegrationContext, setupIntegration, teardownIntegration } from '../helpers';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// Spy on @/lib/embedding/enqueue, @/lib/search/client and
// @/lib/embedding/cascade — applyProposal's per-kind side effects are the
// whole point of this test file, and asserting them against real tables
// isn't possible (no worker runs in the integration harness; enqueueEmbed
// only sends a pg-boss job). Mocking cascade directly (rather than letting
// the real cascade run against seeded children) means the "fires the rename
// cascade" assertions don't depend on which child rows happen to exist.

const revalidateCalls: string[] = [];
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn((path: string) => {
    revalidateCalls.push(path);
  }),
}));

vi.mock('@/lib/auth', async () => {
  const { currentUserId } = await import('../ai/_mock-auth');
  return {
    auth: vi.fn(async () => {
      const id = currentUserId();
      return id ? { user: { id } } : null;
    }),
  };
});

const embedCalls: { type: string; id: string }[] = [];
vi.mock('@/lib/embedding/enqueue', () => ({
  enqueueEmbed: vi.fn(async (type: string, id: string) => {
    embedCalls.push({ type, id });
  }),
}));

const searchCalls: { kind: string; id: string; op: string }[] = [];
vi.mock('@/lib/search/client', () => ({
  enqueueSearchIndex: vi.fn(async (kind: string, id: string, op: string) => {
    searchCalls.push({ kind, id, op });
  }),
}));

const cascadeCalls: { fn: 'item' | 'system'; id: string }[] = [];
vi.mock('@/lib/embedding/cascade', () => ({
  enqueueItemRenameCascade: vi.fn(async (id: string) => {
    cascadeCalls.push({ fn: 'item', id });
  }),
  enqueueSystemRenameCascade: vi.fn(async (id: string) => {
    cascadeCalls.push({ fn: 'system', id });
  }),
}));

let ctx: IntegrationContext;
let applyProposal: typeof import('@/lib/chat/actions').applyProposal;
let rejectProposal: typeof import('@/lib/chat/actions').rejectProposal;
let refreshProposal: typeof import('@/lib/chat/actions').refreshProposal;

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  ({ applyProposal, rejectProposal, refreshProposal } = await import('@/lib/chat/actions'));
}, 180_000);

afterAll(async () => {
  await teardownIntegration(ctx);
});

async function seed() {
  await ctx.prisma.chatProposal.deleteMany();
  await ctx.prisma.chatMessage.deleteMany();
  await ctx.prisma.chatSession.deleteMany();
  await ctx.prisma.serviceRecordTarget.deleteMany();
  await ctx.prisma.serviceRecord.deleteMany();
  await ctx.prisma.note.deleteMany();
  await ctx.prisma.item.deleteMany();
  await ctx.prisma.system.deleteMany();
  await ctx.prisma.category.deleteMany();
  await ctx.prisma.session.deleteMany();
  await ctx.prisma.account.deleteMany();
  await ctx.prisma.user.deleteMany();

  const u = await ctx.prisma.user.create({ data: { email: 'chat-apply@x', name: 'C' } });
  userId = u.id;
  const other = await ctx.prisma.user.create({ data: { email: 'chat-apply-other@x', name: 'O' } });
  otherUserId = other.id;
  signInAs(userId);

  await ctx.prisma.category.create({ data: { id: 'cat-1', slug: 'appliance', name: 'Appliance' } });
  await ctx.prisma.item.create({
    data: { id: 'item-1', name: 'Furnace', categoryId: 'cat-1' },
  });
  await ctx.prisma.system.create({ data: { id: 'sys-1', name: 'HVAC' } });
  await ctx.prisma.note.create({
    data: { id: 'note-1', title: 'Lightbulbs', body: 'Assorted bulbs.' },
  });
}

async function createProposal(opts: {
  kind: ChatProposalKind;
  payload: unknown;
  targetType?: string | null;
  targetId?: string | null;
  baseUpdatedAt?: Date | null;
  beforeSnapshot?: unknown;
  status?: ChatProposalStatus;
  forUserId?: string;
}) {
  const chatSession = await ctx.prisma.chatSession.create({
    data: { userId: opts.forUserId ?? userId, title: 'Test session' },
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

describe('applyProposal / rejectProposal / refreshProposal', () => {
  beforeEach(async () => {
    embedCalls.length = 0;
    searchCalls.length = 0;
    cascadeCalls.length = 0;
    revalidateCalls.length = 0;
    await seed();
  });

  it('applies CREATE_NOTE: writes the row, indexes + embeds, flips to ACCEPTED', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_NOTE',
      payload: {
        kind: 'CREATE_NOTE',
        title: { value: 'Filter size', source: 'user' },
        body: { value: '16x25x1', source: 'user' },
        itemId: 'item-1',
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const note = await ctx.prisma.note.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(note.title).toBe('Filter size');
    expect(note.body).toBe('16x25x1');
    expect(note.itemId).toBe('item-1');

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('ACCEPTED');
    expect(updated.appliedEntityId).toBe(note.id);
    expect(updated.appliedAt).not.toBeNull();

    // An applied note ENQUEUES an embed job — asserted against the enqueue
    // spy, not the embeddings table (no worker runs here).
    expect(embedCalls).toContainEqual({ type: 'NOTE', id: note.id });
    expect(searchCalls).toContainEqual({ kind: 'note', id: note.id, op: 'upsert' });
    expect(revalidateCalls).toEqual(
      expect.arrayContaining(['/notes', '/dashboard', '/items/item-1', '/ask']),
    );
  });

  it('applies UPDATE_NOTE against the fresh baseUpdatedAt', async () => {
    const existing = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
    const proposal = await createProposal({
      kind: 'UPDATE_NOTE',
      targetType: 'NOTE',
      targetId: 'note-1',
      baseUpdatedAt: existing.updatedAt,
      beforeSnapshot: { body: existing.body },
      payload: {
        kind: 'UPDATE_NOTE',
        noteId: 'note-1',
        body: { value: 'Updated bulb list.', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);

    const note = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
    expect(note.body).toBe('Updated bulb list.');
    expect(embedCalls).toContainEqual({ type: 'NOTE', id: 'note-1' });
    expect(revalidateCalls).toEqual(
      expect.arrayContaining(['/notes', '/notes/note-1', '/dashboard', '/ask']),
    );
  });

  it('applies CREATE_ITEM, merging _provenance into metadata', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_ITEM',
      payload: {
        kind: 'CREATE_ITEM',
        name: { value: 'Toaster', source: 'user' },
        categoryId: 'cat-1',
        manufacturer: { value: 'Acme', source: 'inferred' },
        purchaseDate: { value: '2026-07-15', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const item = await ctx.prisma.item.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(item.name).toBe('Toaster');
    expect(item.manufacturer).toBe('Acme');
    expect(item.purchaseDate?.toISOString().slice(0, 10)).toBe('2026-07-15');
    expect((item.metadata as Record<string, unknown>)._provenance).toEqual({
      name: 'user',
      manufacturer: 'inferred',
      purchaseDate: 'user',
    });

    expect(embedCalls).toContainEqual({ type: 'ITEM', id: item.id });
    expect(searchCalls).toContainEqual({ kind: 'item', id: item.id, op: 'upsert' });
    // Create kinds never cascade — nothing points at a brand-new id yet.
    expect(cascadeCalls).toHaveLength(0);
    expect(revalidateCalls).toEqual(expect.arrayContaining(['/items', '/dashboard', '/ask']));
  });

  it('applies UPDATE_ITEM and fires enqueueItemRenameCascade in addition to index + embed', async () => {
    const existing = await ctx.prisma.item.findUniqueOrThrow({ where: { id: 'item-1' } });
    const proposal = await createProposal({
      kind: 'UPDATE_ITEM',
      targetType: 'ITEM',
      targetId: 'item-1',
      baseUpdatedAt: existing.updatedAt,
      beforeSnapshot: { serialNumber: existing.serialNumber },
      payload: {
        kind: 'UPDATE_ITEM',
        itemId: 'item-1',
        serialNumber: { value: 'SN-99', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);

    const item = await ctx.prisma.item.findUniqueOrThrow({ where: { id: 'item-1' } });
    expect(item.serialNumber).toBe('SN-99');
    expect((item.metadata as Record<string, unknown>)._provenance).toEqual({
      serialNumber: 'user',
    });

    expect(embedCalls).toContainEqual({ type: 'ITEM', id: 'item-1' });
    expect(searchCalls).toContainEqual({ kind: 'item', id: 'item-1', op: 'upsert' });
    expect(cascadeCalls).toContainEqual({ fn: 'item', id: 'item-1' });
    expect(revalidateCalls).toEqual(
      expect.arrayContaining(['/items', '/items/item-1', '/dashboard', '/ask']),
    );
  });

  it('UPDATE_ITEM still applies (ACCEPTED) when the rename cascade throws', async () => {
    // enqueueItemRenameCascade / enqueueSystemRenameCascade (lib/embedding/
    // cascade.ts) run raw prisma.*.findMany with no try/catch of their own —
    // unlike enqueueEmbed/enqueueSearchIndex, which swallow their own
    // errors. The cascade call fires AFTER the item update already
    // succeeded but BEFORE status flips to ACCEPTED, so an uncaught throw
    // here would leave the item renamed while the proposal still reads
    // PENDING. applyUpdateItem must catch it locally.
    vi.mocked(enqueueItemRenameCascade).mockRejectedValueOnce(new Error('cascade db error'));

    const existing = await ctx.prisma.item.findUniqueOrThrow({ where: { id: 'item-1' } });
    const proposal = await createProposal({
      kind: 'UPDATE_ITEM',
      targetType: 'ITEM',
      targetId: 'item-1',
      baseUpdatedAt: existing.updatedAt,
      beforeSnapshot: { serialNumber: existing.serialNumber },
      payload: {
        kind: 'UPDATE_ITEM',
        itemId: 'item-1',
        serialNumber: { value: 'SN-CASCADE-FAIL', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);

    const item = await ctx.prisma.item.findUniqueOrThrow({ where: { id: 'item-1' } });
    expect(item.serialNumber).toBe('SN-CASCADE-FAIL');

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('ACCEPTED');
  });

  it('applies UPDATE_SYSTEM: fires enqueueSystemRenameCascade only, no index or embed', async () => {
    const existing = await ctx.prisma.system.findUniqueOrThrow({ where: { id: 'sys-1' } });
    const proposal = await createProposal({
      kind: 'UPDATE_SYSTEM',
      targetType: 'SYSTEM',
      targetId: 'sys-1',
      baseUpdatedAt: existing.updatedAt,
      beforeSnapshot: { name: existing.name },
      payload: {
        kind: 'UPDATE_SYSTEM',
        systemId: 'sys-1',
        name: { value: 'Main HVAC', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);

    const system = await ctx.prisma.system.findUniqueOrThrow({ where: { id: 'sys-1' } });
    expect(system.name).toBe('Main HVAC');
    expect((system.metadata as Record<string, unknown>)._provenance).toEqual({ name: 'user' });

    expect(cascadeCalls).toContainEqual({ fn: 'system', id: 'sys-1' });
    expect(searchCalls).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
    expect(revalidateCalls).toEqual(expect.arrayContaining(['/systems', '/systems/sys-1', '/ask']));
  });

  it('applies CREATE_SERVICE_RECORD with nested targets, storing performedOn as the correct UTC day', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_SERVICE_RECORD',
      payload: {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Reset water heater', source: 'user' },
        performedOn: { value: '2026-07-03', source: 'user' },
        selfPerformed: true,
        targets: [{ itemId: 'item-1', systemId: null }],
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const record = await ctx.prisma.serviceRecord.findUniqueOrThrow({
      where: { id: result.data.id },
      include: { targets: true },
    });
    expect(record.summary).toBe('Reset water heater');
    expect(record.performedOn.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(record.targets).toHaveLength(1);
    expect(record.targets[0].itemId).toBe('item-1');

    expect(embedCalls).toContainEqual({ type: 'SERVICE_RECORD', id: record.id });
    expect(searchCalls).toContainEqual({ kind: 'service', id: record.id, op: 'upsert' });
    expect(revalidateCalls).toEqual(
      expect.arrayContaining(['/service', '/dashboard', '/items/item-1', '/ask']),
    );
  });

  it('baseUpdatedAt mismatch yields STALE and performs no write', async () => {
    const existing = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
    const stale = new Date(existing.updatedAt.getTime() - 60_000);
    const proposal = await createProposal({
      kind: 'UPDATE_NOTE',
      targetType: 'NOTE',
      targetId: 'note-1',
      baseUpdatedAt: stale,
      payload: {
        kind: 'UPDATE_NOTE',
        noteId: 'note-1',
        body: { value: 'Should not land.', source: 'user' },
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toMatch(/changed/i);

    const note = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
    expect(note.body).toBe('Assorted bulbs.');

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('STALE');
  });

  it('a deleted target yields ORPHANED and performs no write', async () => {
    const existing = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
    const proposal = await createProposal({
      kind: 'UPDATE_NOTE',
      targetType: 'NOTE',
      targetId: 'note-1',
      baseUpdatedAt: existing.updatedAt,
      payload: {
        kind: 'UPDATE_NOTE',
        noteId: 'note-1',
        body: { value: 'Should not land.', source: 'user' },
      },
    });

    await ctx.prisma.note.delete({ where: { id: 'note-1' } });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toMatch(/deleted/i);

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('ORPHANED');
  });

  it('re-applying an ACCEPTED proposal is a no-op, not a duplicate row', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_NOTE',
      payload: {
        kind: 'CREATE_NOTE',
        title: { value: 'One-off', source: 'user' },
        body: { value: 'Body', source: 'user' },
        itemId: null,
      },
    });

    const first = await applyProposal(proposal.id);
    expect(first.ok).toBe(true);
    expect(await ctx.prisma.note.count()).toBe(2); // seeded note-1 + this one

    const second = await applyProposal(proposal.id);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected failure');
    expect(second.formError).toMatch(/accepted/i);

    expect(await ctx.prisma.note.count()).toBe(2);
  });

  it('two concurrent applyProposal calls on the same CREATE_NOTE: exactly one succeeds, exactly one note is created', async () => {
    // Regression test for the non-atomic PENDING -> ACCEPTED transition:
    // loadOwnedProposal reads status, business logic runs, and only THEN
    // does the terminal write happen — a naive `prisma.chatProposal.update`
    // keyed on `id` alone lets two near-simultaneous callers both pass the
    // status check before either writes back, producing two notes for one
    // proposal. `Promise.all` (not sequential awaits) is essential here —
    // sequential calls would pass even with the bug, since the first call's
    // write completes and flips status before the second call ever reads it.
    const proposal = await createProposal({
      kind: 'CREATE_NOTE',
      payload: {
        kind: 'CREATE_NOTE',
        title: { value: 'Concurrent note', source: 'user' },
        body: { value: 'Body', source: 'user' },
        itemId: null,
      },
    });

    const [first, second] = await Promise.all([
      applyProposal(proposal.id),
      applyProposal(proposal.id),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (failed[0]?.ok !== false) throw new Error('expected a failure');
    // Whichever call loses the race sees a rejection either way: it may lose
    // at the CAS `updateMany` itself ("already handled") or, if the winner's
    // whole request completes first, at the early status read at the top of
    // applyProposal ("is accepted and cannot be applied"). Both are correct
    // — the assertion that matters is the counts below: exactly one note,
    // exactly one ACCEPTED proposal.
    expect(failed[0].formError).toMatch(/already handled|accepted and cannot/i);

    // seeded note-1 + exactly one new note from whichever call won the race.
    expect(await ctx.prisma.note.count()).toBe(2);

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('ACCEPTED');
    expect(updated.appliedEntityId).not.toBeNull();
  });

  it('an unparseable stored payload yields INVALID rather than throwing', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_NOTE',
      payload: { kind: 'NOT_A_REAL_KIND', garbage: true },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toMatch(/schema change/i);

    const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(updated.status).toBe('INVALID');
  });

  it('rejects the ownership check: a proposal belonging to another user is not found', async () => {
    const proposal = await createProposal({
      kind: 'CREATE_NOTE',
      forUserId: otherUserId,
      payload: {
        kind: 'CREATE_NOTE',
        title: { value: 'Not yours', source: 'user' },
        body: { value: 'Body', source: 'user' },
        itemId: null,
      },
    });

    const result = await applyProposal(proposal.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.formError).toMatch(/not found/i);
    expect(await ctx.prisma.note.count()).toBe(1); // only seeded note-1
  });

  describe('rejectProposal', () => {
    it('rejects a PENDING proposal', async () => {
      const proposal = await createProposal({
        kind: 'CREATE_NOTE',
        payload: {
          kind: 'CREATE_NOTE',
          title: { value: 'x', source: 'user' },
          body: { value: 'y', source: 'user' },
          itemId: null,
        },
      });

      const result = await rejectProposal(proposal.id);
      expect(result.ok).toBe(true);

      const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(updated.status).toBe('REJECTED');
    });

    it('refuses to reject an already-ACCEPTED proposal', async () => {
      const proposal = await createProposal({
        kind: 'CREATE_NOTE',
        status: 'ACCEPTED',
        payload: {
          kind: 'CREATE_NOTE',
          title: { value: 'x', source: 'user' },
          body: { value: 'y', source: 'user' },
          itemId: null,
        },
      });

      const result = await rejectProposal(proposal.id);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.formError).toMatch(/accepted/i);

      const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(updated.status).toBe('ACCEPTED');
    });
  });

  describe('refreshProposal', () => {
    it('recomputes baseUpdatedAt + beforeSnapshot from the current row and returns to PENDING', async () => {
      const current = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
      const staleBase = new Date(current.updatedAt.getTime() - 60_000);
      const proposal = await createProposal({
        kind: 'UPDATE_NOTE',
        targetType: 'NOTE',
        targetId: 'note-1',
        status: 'STALE',
        baseUpdatedAt: staleBase,
        beforeSnapshot: { body: 'stale snapshot' },
        payload: {
          kind: 'UPDATE_NOTE',
          noteId: 'note-1',
          body: { value: 'Refreshed value.', source: 'user' },
        },
      });

      const result = await refreshProposal(proposal.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.data.proposal.status).toBe('PENDING');
      expect(result.data.proposal.baseUpdatedAt?.getTime()).toBe(current.updatedAt.getTime());
      expect(result.data.proposal.beforeSnapshot).toEqual({ body: current.body });

      // The refreshed proposal then applies successfully.
      const applied = await applyProposal(proposal.id);
      expect(applied.ok).toBe(true);
      const note = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
      expect(note.body).toBe('Refreshed value.');
    });

    it('on a PENDING proposal returns formError and changes nothing', async () => {
      const current = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
      const proposal = await createProposal({
        kind: 'UPDATE_NOTE',
        targetType: 'NOTE',
        targetId: 'note-1',
        baseUpdatedAt: current.updatedAt,
        beforeSnapshot: { body: current.body },
        payload: {
          kind: 'UPDATE_NOTE',
          noteId: 'note-1',
          body: { value: 'Irrelevant.', source: 'user' },
        },
      });

      const result = await refreshProposal(proposal.id);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.formError).toMatch(/not stale/i);

      const unchanged = await ctx.prisma.chatProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(unchanged.status).toBe('PENDING');
      expect(unchanged.baseUpdatedAt?.getTime()).toBe(current.updatedAt.getTime());
    });

    it('on a deleted target yields ORPHANED, not PENDING', async () => {
      const current = await ctx.prisma.note.findUniqueOrThrow({ where: { id: 'note-1' } });
      const proposal = await createProposal({
        kind: 'UPDATE_NOTE',
        targetType: 'NOTE',
        targetId: 'note-1',
        status: 'STALE',
        baseUpdatedAt: current.updatedAt,
        beforeSnapshot: { body: current.body },
        payload: {
          kind: 'UPDATE_NOTE',
          noteId: 'note-1',
          body: { value: 'Irrelevant.', source: 'user' },
        },
      });

      await ctx.prisma.note.delete({ where: { id: 'note-1' } });

      const result = await refreshProposal(proposal.id);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.formError).toMatch(/deleted/i);

      const updated = await ctx.prisma.chatProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(updated.status).toBe('ORPHANED');
    });
  });
});
