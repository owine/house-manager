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
    expect(parseStoredPayload(null)).toBeNull();
    expect(parseStoredPayload('not an object')).toBeNull();
  });
});
