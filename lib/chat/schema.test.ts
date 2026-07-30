import { describe, expect, it } from 'vitest';
import { NOTE_BODY_MAX, parseStoredPayload, proposalPayloadSchema } from './schema';

const createNote = {
  kind: 'CREATE_NOTE' as const,
  title: { value: 'Lightbulbs', source: 'user' as const },
  body: { value: '## Kitchen\n9W A19 2700K', source: 'inferred' as const },
  itemId: null,
};

describe('proposalPayloadSchema', () => {
  it('accepts a well-formed CREATE_NOTE payload', () => {
    expect(proposalPayloadSchema.safeParse(createNote).success).toBe(true);
  });

  it('discriminates on kind', () => {
    const r = proposalPayloadSchema.safeParse({ ...createNote, kind: 'UPDATE_ITEM' });
    expect(r.success).toBe(false);
  });

  it('rejects a note body over the length ceiling', () => {
    const r = proposalPayloadSchema.safeParse({
      ...createNote,
      body: { value: 'x'.repeat(NOTE_BODY_MAX + 1), source: 'user' },
    });
    expect(r.success).toBe(false);
  });

  it('requires categoryId on CREATE_ITEM', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_ITEM',
      name: { value: 'Pendant', source: 'user' },
    });
    expect(r.success).toBe(false);
  });

  it('carries provenance through', () => {
    const r = proposalPayloadSchema.parse(createNote);
    if (r.kind !== 'CREATE_NOTE') throw new Error('wrong kind');
    expect(r.body.source).toBe('inferred');
  });

  it('accepts a well-formed UPDATE_NOTE payload', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'UPDATE_NOTE',
      noteId: 'note-1',
      body: { value: 'Replacement body text', source: 'user' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a well-formed UPDATE_ITEM payload', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'UPDATE_ITEM',
      itemId: 'item-1',
      location: { value: 'Garage', source: 'inferred' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a well-formed UPDATE_SYSTEM payload', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'UPDATE_SYSTEM',
      systemId: 'system-1',
      notes: { value: 'Filter replaced', source: 'user' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a well-formed CREATE_SERVICE_RECORD payload', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Furnace tune-up', source: 'user' },
      performedOn: { value: '2026-07-15', source: 'user' },
      selfPerformed: false,
      targets: [{ itemId: null, systemId: 'system-1' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects CREATE_SERVICE_RECORD with no targets', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Furnace tune-up', source: 'user' },
      performedOn: { value: '2026-07-15', source: 'user' },
      selfPerformed: false,
      targets: [],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a well-formed CREATE_PART payload', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_PART',
      name: { value: 'String light bulbs', source: 'user' },
      partKind: { value: 'BULB', source: 'inferred' },
      manufacturer: { value: 'Feit', source: 'user' },
      typicalCost: { value: '4.50', source: 'user' },
      metadata: { value: { base: 'E26', wattage: 11 }, source: 'user' },
      itemId: 'item-1',
    });
    expect(r.success).toBe(true);
  });

  it('accepts CREATE_PART with neither itemId nor systemId', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_PART',
      name: { value: 'Generic AA batteries', source: 'user' },
      partKind: { value: 'BATTERY', source: 'user' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects CREATE_PART carrying both itemId and systemId', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_PART',
      name: { value: 'Air filter', source: 'user' },
      partKind: { value: 'AIR_FILTER', source: 'user' },
      itemId: 'item-1',
      systemId: 'system-1',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a partKind outside PART_KINDS', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_PART',
      name: { value: 'Mystery part', source: 'user' },
      partKind: { value: 'bulb', source: 'inferred' },
    });
    expect(r.success).toBe(false);
  });

  it.each(['about $4.50', '4.505', '$4.50', '', '4.5.0'])(
    'rejects typicalCost %j',
    (typicalCost) => {
      const r = proposalPayloadSchema.safeParse({
        kind: 'CREATE_PART',
        name: { value: 'Bulb', source: 'user' },
        partKind: { value: 'BULB', source: 'user' },
        typicalCost: { value: typicalCost, source: 'inferred' },
      });
      expect(r.success).toBe(false);
    },
  );

  it.each(['4.50', '4', '4.5', '12345678.99'])('accepts typicalCost %j', (typicalCost) => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_PART',
      name: { value: 'Bulb', source: 'user' },
      partKind: { value: 'BULB', source: 'user' },
      typicalCost: { value: typicalCost, source: 'inferred' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a well-formed UPDATE_PART payload', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'UPDATE_PART',
      partId: 'part-1',
      model: { value: 'BR30-927-DIM', source: 'user' },
      metadata: { value: { colorTemperatureK: 2700 }, source: 'inferred' },
    });
    expect(r.success).toBe(true);
  });

  it('requires partId on UPDATE_PART', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'UPDATE_PART',
      model: { value: 'BR30-927-DIM', source: 'user' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects CREATE_SERVICE_RECORD with a non-ISO performedOn', () => {
    const r = proposalPayloadSchema.safeParse({
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Furnace tune-up', source: 'user' },
      performedOn: { value: '3rd July 2026', source: 'user' },
      selfPerformed: false,
      targets: [{ itemId: null, systemId: 'system-1' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('parseStoredPayload', () => {
  it('returns the payload when it still parses', () => {
    expect(parseStoredPayload(createNote)).toEqual(createNote);
  });

  it('returns null instead of throwing when the union has moved on', () => {
    expect(parseStoredPayload({ kind: 'SOMETHING_REMOVED' })).toBeNull();
    // A CREATE_PART whose stored shape no longer matches — partKind gone.
    expect(
      parseStoredPayload({ kind: 'CREATE_PART', name: { value: 'Bulb', source: 'user' } }),
    ).toBeNull();
    expect(parseStoredPayload(null)).toBeNull();
    expect(parseStoredPayload('not an object')).toBeNull();
  });
});
