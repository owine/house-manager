import { describe, expect, it, vi } from 'vitest';
import { type Snapshot, validateProposal } from './resolve';
import type { ProposalPayload } from './schema';

// Only ONE arm reaches the database: UPDATE_PART carrying `metadata` but no
// `partKind`, which has to resolve the part's stored kind before it can pick a
// spec schema. Everything else here is pure.
const findUniquePart = vi.fn(async () => ({ kind: 'BULB' as const }));
vi.mock('@/lib/db', () => ({
  prisma: { part: { findUnique: (...args: unknown[]) => findUniquePart(...(args as [])) } },
}));

const snapshot: Snapshot = {
  itemIds: new Set(['item-1']),
  systemIds: new Set(['sys-1']),
  categoryIds: new Set(['cat-1']),
  noteIds: new Set(['note-1']),
  partIds: new Set(['part-1']),
};

const createItem = (over: Record<string, unknown> = {}): ProposalPayload =>
  ({
    kind: 'CREATE_ITEM',
    name: { value: 'Pendant', source: 'user' },
    categoryId: 'cat-1',
    ...over,
  }) as ProposalPayload;

describe('validateProposal', () => {
  it('accepts a proposal whose IDs are all in the snapshot', async () => {
    expect((await validateProposal(createItem(), snapshot)).ok).toBe(true);
  });

  it('rejects a hallucinated categoryId', async () => {
    const r = await validateProposal(createItem({ categoryId: 'cat-nope' }), snapshot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/categoryId/);
  });

  it('rejects a hallucinated itemId on UPDATE_ITEM', async () => {
    const r = await validateProposal(
      {
        kind: 'UPDATE_ITEM',
        itemId: 'item-nope',
        name: { value: 'x', source: 'user' },
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a service record targeting an unknown system', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Flush', source: 'user' },
        performedOn: { value: '2026-07-03', source: 'user' },
        selfPerformed: true,
        targets: [{ itemId: null, systemId: 'sys-nope' }],
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an unparseable calendar date', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Flush', source: 'user' },
        performedOn: { value: '2026-02-30', source: 'user' },
        selfPerformed: true,
        targets: [{ itemId: 'item-1', systemId: null }],
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/date/i);
  });

  // `service_record_targets` carries a hand-written XOR CHECK constraint that
  // Prisma cannot regenerate. Both ids are valid here — the rejection must come
  // from the XOR rule, not from a snapshot miss. Letting this through would
  // throw a Prisma constraint error from inside a server action, violating the
  // never-throw skeleton.
  it('rejects a service-record target naming both an item and a system', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Flush', source: 'user' },
        performedOn: { value: '2026-07-03', source: 'user' },
        selfPerformed: true,
        targets: [{ itemId: 'item-1', systemId: 'sys-1' }],
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exactly one/i);
  });

  it('allows a null itemId on CREATE_NOTE (house-general knowledge)', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_NOTE',
        title: { value: 'Lightbulbs', source: 'user' },
        body: { value: '## Kitchen', source: 'user' },
        itemId: null,
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a hallucinated partId on UPDATE_PART', async () => {
    const r = await validateProposal(
      { kind: 'UPDATE_PART', partId: 'part-nope' } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/partId/);
  });

  it('rejects a CREATE_PART naming a parent that is not in the snapshot', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_PART',
        name: { value: 'BR30', source: 'user' },
        partKind: { value: 'BULB', source: 'user' },
        systemId: 'sys-nope',
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/systemId/);
  });

  // Unparented is the legal standalone "generic bulbs" case — unlike
  // CREATE_SERVICE_RECORD there is no lower bound on parents.
  it('allows a CREATE_PART with no parent at all', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_PART',
        name: { value: 'AA batteries', source: 'user' },
        partKind: { value: 'BATTERY', source: 'user' },
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a spec that fails the schema its partKind selects', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_PART',
        name: { value: 'BR30', source: 'user' },
        partKind: { value: 'BULB', source: 'user' },
        spec: { value: { watts: 'nine' }, source: 'inferred' },
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/spec/);
  });

  // Non-strict z.object: an invented key is dropped, not rejected. The check
  // exists to catch wrong-TYPED values, not unknown ones.
  it('allows an invented spec key', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_PART',
        name: { value: 'BR30', source: 'user' },
        partKind: { value: 'BULB', source: 'user' },
        spec: { value: { bulbColour: 'warm' }, source: 'inferred' },
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(true);
  });

  // The extraction model emits an explicit null for "the user didn't say", and
  // the per-kind schemas take neither null nor a foreign key — stripped, not
  // rejected, or every part with a partly-filled spec would be dropped.
  it('treats a null spec value as absent', async () => {
    const r = await validateProposal(
      {
        kind: 'CREATE_PART',
        name: { value: 'BR30', source: 'user' },
        partKind: { value: 'BULB', source: 'user' },
        spec: { value: { base: 'E26', watts: null }, source: 'user' },
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(true);
  });

  it('resolves the stored kind when UPDATE_PART omits partKind', async () => {
    findUniquePart.mockClear();
    const r = await validateProposal(
      {
        kind: 'UPDATE_PART',
        partId: 'part-1',
        spec: { value: { watts: 'nine' }, source: 'inferred' },
      } as ProposalPayload,
      snapshot,
    );
    expect(findUniquePart).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
  });
});
