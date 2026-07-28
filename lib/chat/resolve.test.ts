import { describe, expect, it } from 'vitest';
import { type Snapshot, validateProposal } from './resolve';
import type { ProposalPayload } from './schema';

const snapshot: Snapshot = {
  itemIds: new Set(['item-1']),
  systemIds: new Set(['sys-1']),
  categoryIds: new Set(['cat-1']),
  noteIds: new Set(['note-1']),
};

const createItem = (over: Record<string, unknown> = {}): ProposalPayload =>
  ({
    kind: 'CREATE_ITEM',
    name: { value: 'Pendant', source: 'user' },
    categoryId: 'cat-1',
    ...over,
  }) as ProposalPayload;

describe('validateProposal', () => {
  it('accepts a proposal whose IDs are all in the snapshot', () => {
    expect(validateProposal(createItem(), snapshot).ok).toBe(true);
  });

  it('rejects a hallucinated categoryId', () => {
    const r = validateProposal(createItem({ categoryId: 'cat-nope' }), snapshot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/categoryId/);
  });

  it('rejects a hallucinated itemId on UPDATE_ITEM', () => {
    const r = validateProposal(
      {
        kind: 'UPDATE_ITEM',
        itemId: 'item-nope',
        name: { value: 'x', source: 'user' },
      } as ProposalPayload,
      snapshot,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a service record targeting an unknown system', () => {
    const r = validateProposal(
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

  it('rejects an unparseable calendar date', () => {
    const r = validateProposal(
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
  it('rejects a service-record target naming both an item and a system', () => {
    const r = validateProposal(
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

  it('allows a null itemId on CREATE_NOTE (house-general knowledge)', () => {
    const r = validateProposal(
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
});
