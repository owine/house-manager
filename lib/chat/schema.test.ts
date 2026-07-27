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
