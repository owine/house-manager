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

  it('puts parts in scope for both create and update', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/create notes, items, parts and service records/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/update\s+notes, items, systems and parts/);
  });

  it('tells the model when a part is right rather than an item', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Parts vs items/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Bulbs are a part; the\s+light fixture is an item/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/SPECIFICATION/);
  });

  it('routes specs to metadata rather than notes prose', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/metadata/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/NOT in "notes" as prose/);
  });

  // The guard against the spec table and `partKindConfigs` drifting apart: a
  // field added to a kind's schema but not surfaced to the model is invisible
  // — the model just never proposes it.
  it('lists every spec field of every structured part kind', () => {
    for (const [kind, schema] of Object.entries(partKindConfigs)) {
      if (!(schema instanceof z.ZodObject)) continue;
      expect(CHAT_SYSTEM_PROMPT).toContain(`${kind}: `);
      for (const field of Object.keys(schema.shape)) {
        expect(CHAT_SYSTEM_PROMPT, `${kind}.${field} missing from the prompt`).toContain(field);
      }
    }
  });

  it('spells out the options for enum-valued spec fields', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('technology (LED|incandescent|halogen|CFL|fluorescent)');
    expect(CHAT_SYSTEM_PROMPT).toContain('form (pellet|crystal|liquid|tablet|powder)');
  });

  it('describes OTHER as freeform rather than listing fields', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/OTHER: any keys/);
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
