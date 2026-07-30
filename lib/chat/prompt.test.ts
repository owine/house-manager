import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { partKindConfigs } from '@/lib/parts/kinds';
import { buildSnapshotBlock, CHAT_SYSTEM_PROMPT } from './prompt';

describe('CHAT_SYSTEM_PROMPT', () => {
  it('forbids inventing IDs', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never.*(invent|make up)/i);
  });

  it('requires YYYY-MM-DD dates', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('YYYY-MM-DD');
  });

  it('instructs short topic-scoped notes', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/##/);
  });

  it('forbids echoing PII from retrieved context', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/serial numbers?/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/PII/);
  });

  it("keeps parts out of the main call's scope", () => {
    // Parts are proposed by the separate unconstrained extraction call, so the
    // main prompt must NOT offer them — see lib/chat/parts-extract.ts.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/create notes, items and service records/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/update notes,\s+items and systems/);
  });

  it('tells the model to leave consumables alone rather than making an item', () => {
    // The reported bug: asked about bulbs, the model created an Item and threw
    // the specs away. Without this instruction BOTH calls now propose something
    // for the same bulbs and the user sees a duplicate.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Do NOT create an item for one/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/SPECIFICATION/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Bulbs are a part; the\s+fixture they go in is an item/);
  });

  it('does not carry the spec-field table — the extraction prompt owns that', () => {
    for (const [kind, schema] of Object.entries(partKindConfigs)) {
      if (!(schema instanceof z.ZodObject)) continue;
      expect(CHAT_SYSTEM_PROMPT).not.toContain(`${kind}: `);
    }
  });

  it('still lists parts among the referenceable ids, since the snapshot has them', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/item, system, category, note and part/);
  });
});

describe('buildSnapshotBlock', () => {
  it('includes the anchor date and every referenceable id', () => {
    const block = buildSnapshotBlock({
      anchorDay: '2026-07-03',
      items: [
        { id: 'item-1', name: 'Water Heater', categoryName: 'Plumbing', location: 'Basement' },
      ],
      systems: [{ id: 'sys-1', name: 'HVAC', location: null }],
      categories: [{ id: 'cat-1', name: 'Lighting' }],
      notes: [{ id: 'note-1', title: 'Lightbulbs' }],
      parts: [
        { id: 'part-1', name: 'Porch bulbs', kind: 'BULB', manufacturer: 'Philips', model: null },
      ],
    });

    expect(block).toContain('2026-07-03');
    expect(block).toContain('item-1');
    expect(block).toContain('sys-1');
    expect(block).toContain('cat-1');
    expect(block).toContain('note-1');
    expect(block).toContain('PARTS (id | name | kind | manufacturer | model)');
    expect(block).toContain('part-1 | Porch bulbs | BULB | Philips | -');
  });
});
