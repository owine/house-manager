import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { partKindConfigs } from '@/lib/parts/kinds';
import type { Snapshot } from './resolve';

vi.mock('@/lib/db', () => ({
  prisma: { part: { findUnique: vi.fn(async () => ({ kind: 'BULB' })) } },
}));

const { PARTS_EXTRACT_PROMPT, parsePartProposals, assemblePrefilledJson } = await import(
  './parts-extract'
);

const snapshot: Snapshot = {
  itemIds: new Set(['item-1']),
  systemIds: new Set(['sys-1']),
  categoryIds: new Set(['cat-1']),
  noteIds: new Set(),
  partIds: new Set(['part-1']),
};

describe('PARTS_EXTRACT_PROMPT', () => {
  it('routes specs to the spec object rather than notes prose', () => {
    expect(PARTS_EXTRACT_PROMPT).toMatch(/Specs go in "spec"/);
    expect(PARTS_EXTRACT_PROMPT).toMatch(/never as prose in "notes"/);
  });

  it('demands bare JSON, which is what the assistant prefill enforces', () => {
    expect(PARTS_EXTRACT_PROMPT).toMatch(/single JSON object and no other text/);
    expect(PARTS_EXTRACT_PROMPT).toContain('{"proposals": [ ... ]}');
  });

  it('tells the model to return nothing when no consumable was described', () => {
    expect(PARTS_EXTRACT_PROMPT).toMatch(/empty "proposals" array/);
    expect(PARTS_EXTRACT_PROMPT).toMatch(/Never invent one/);
  });

  it('forbids inventing ids', () => {
    expect(PARTS_EXTRACT_PROMPT).toMatch(/NEVER invent an id/);
  });

  // The drift guard: a field added to a kind's schema but never surfaced to the
  // model is invisible — the model simply never proposes it, and nothing fails.
  it('lists every spec field of every structured part kind', () => {
    for (const [kind, schema] of Object.entries(partKindConfigs)) {
      if (!(schema instanceof z.ZodObject)) continue;
      expect(PARTS_EXTRACT_PROMPT).toContain(`${kind}: `);
      for (const field of Object.keys(schema.shape)) {
        expect(PARTS_EXTRACT_PROMPT, `${kind}.${field} missing from the prompt`).toContain(field);
      }
    }
  });

  it('spells out the options for enum-valued spec fields', () => {
    expect(PARTS_EXTRACT_PROMPT).toContain('technology (LED|incandescent|halogen|CFL|fluorescent)');
    expect(PARTS_EXTRACT_PROMPT).toContain('form (pellet|crystal|liquid|tablet|powder)');
  });

  it('describes OTHER as freeform rather than listing fields', () => {
    expect(PARTS_EXTRACT_PROMPT).toMatch(/OTHER: any keys/);
  });
});

const createPart = {
  kind: 'CREATE_PART',
  name: { value: 'S14 bulbs', source: 'user' },
  partKind: { value: 'BULB', source: 'inferred' },
  spec: { value: { base: 'E26', shape: 'S14', watts: 11, colorTempK: 2700 }, source: 'user' },
  itemId: 'item-1',
};

// Unconstrained output means every one of these is a real thing the model can
// hand back, not a hypothetical. All of them must degrade to "no proposals"
// rather than throwing — conversational capture treats an unusable payload as
// a non-event, and a thrown error here would take the whole chat turn down.
describe('parsePartProposals', () => {
  it('parses the shape the spike produced', async () => {
    const out = await parsePartProposals(JSON.stringify({ proposals: [createPart] }), snapshot);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('CREATE_PART');
    expect(out[0]?.kind === 'CREATE_PART' && out[0].spec?.value).toEqual({
      base: 'E26',
      shape: 'S14',
      watts: 11,
      colorTempK: 2700,
    });
  });

  it('strips nulls the model emits for "not stated"', async () => {
    const raw = JSON.stringify({
      proposals: [{ ...createPart, spec: { value: { base: 'E26', watts: null }, source: 'user' } }],
    });
    const out = await parsePartProposals(raw, snapshot);
    expect(out[0]?.kind === 'CREATE_PART' && out[0].spec?.value).toEqual({ base: 'E26' });
  });

  it('returns nothing for unparseable JSON', async () => {
    expect(await parsePartProposals('{not json', snapshot)).toEqual([]);
  });

  it('returns nothing when the object has no proposals array', async () => {
    expect(await parsePartProposals('{"reply":"sure thing"}', snapshot)).toEqual([]);
  });

  it('keeps the good proposals when one entry is malformed', async () => {
    const raw = JSON.stringify({ proposals: [{ kind: 'CREATE_PART' }, createPart] });
    expect(await parsePartProposals(raw, snapshot)).toHaveLength(1);
  });

  it('drops a proposal naming an itemId that is not in the snapshot', async () => {
    const raw = JSON.stringify({ proposals: [{ ...createPart, itemId: 'item-hallucinated' }] });
    expect(await parsePartProposals(raw, snapshot)).toEqual([]);
  });

  it('drops a proposal naming a partId that is not in the snapshot', async () => {
    const raw = JSON.stringify({
      proposals: [{ kind: 'UPDATE_PART', partId: 'part-hallucinated' }],
    });
    expect(await parsePartProposals(raw, snapshot)).toEqual([]);
  });

  it('drops a proposal whose spec is wrong-typed for its kind', async () => {
    const raw = JSON.stringify({
      proposals: [{ ...createPart, spec: { value: { watts: 'nine' }, source: 'user' } }],
    });
    expect(await parsePartProposals(raw, snapshot)).toEqual([]);
  });

  it('accepts an empty proposals array — the common case', async () => {
    expect(await parsePartProposals('{"proposals":[]}', snapshot)).toEqual([]);
  });
});

// Sourcery caught this on #332: the original code did `JSON_PREFILL + text`
// unconditionally, so a model that emitted its own leading `{` produced `{{`.
// That fails JSON.parse, and because extraction failure degrades to "no
// proposals" by design, the feature would have gone quiet with no error.
describe('assemblePrefilledJson', () => {
  it('prepends the brace when the model continues after the prefill', () => {
    expect(assemblePrefilledJson('"proposals":[]}')).toBe('{"proposals":[]}');
  });

  it('does NOT double the brace when the model emits its own', () => {
    expect(assemblePrefilledJson('{"proposals":[]}')).toBe('{"proposals":[]}');
  });

  it('tolerates leading whitespace or a newline before either shape', () => {
    expect(assemblePrefilledJson('\n  {"proposals":[]}')).toBe('{"proposals":[]}');
    expect(assemblePrefilledJson('\n  "proposals":[]}')).toBe('{"proposals":[]}');
  });

  it('produces parseable JSON in both shapes', () => {
    for (const body of ['"proposals":[]}', '{"proposals":[]}']) {
      expect(() => JSON.parse(assemblePrefilledJson(body))).not.toThrow();
    }
  });
});
