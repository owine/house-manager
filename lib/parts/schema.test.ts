import { describe, expect, it } from 'vitest';

import { createPartSchema, updatePartSchema } from './schema';

function fieldErrors(result: { success: false; error: import('zod').ZodError }) {
  return result.error.flatten().fieldErrors as Record<string, string[]>;
}

describe('createPartSchema', () => {
  it('accepts a minimal part and defaults kind/metadata/purchaseLinks', () => {
    const parsed = createPartSchema.safeParse({ name: 'Kitchen can lights' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kind).toBe('OTHER');
    expect(parsed.data.metadata).toEqual({});
    expect(parsed.data.purchaseLinks).toEqual([]);
  });

  it('requires a name', () => {
    const parsed = createPartSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(fieldErrors(parsed).name).toContain('Name is required');
  });

  it('rejects an unknown kind', () => {
    const parsed = createPartSchema.safeParse({ name: 'x', kind: 'SPROCKET' });
    expect(parsed.success).toBe(false);
  });

  it('coerces numeric columns and rejects a negative cost', () => {
    const ok = createPartSchema.safeParse({ name: 'x', typicalCost: '4.50', packQuantity: '6' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.typicalCost).toBe(4.5);
      expect(ok.data.packQuantity).toBe(6);
    }
    expect(createPartSchema.safeParse({ name: 'x', typicalCost: -1 }).success).toBe(false);
    expect(createPartSchema.safeParse({ name: 'x', packQuantity: 0 }).success).toBe(false);
    expect(createPartSchema.safeParse({ name: 'x', packQuantity: 1.5 }).success).toBe(false);
  });
});

describe('metadata is validated against the part kind', () => {
  it('accepts a valid bulb spec', () => {
    const parsed = createPartSchema.safeParse({
      name: 'BR30 dimmable',
      kind: 'BULB',
      metadata: { base: 'E26', shape: 'BR30', watts: 9, dimmable: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a bad bulb spec and reports each failure on its own field', () => {
    const parsed = createPartSchema.safeParse({
      name: 'BR30',
      kind: 'BULB',
      metadata: { base: 'E27', watts: -3 },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    // BULB is a structured kind, so PartKindFields registers `metadata.base`
    // and `metadata.watts` and nothing as plain `metadata`. The issue path has
    // to match, or the message renders nowhere while applyActionFieldErrors
    // still reports it as applied.
    const paths = parsed.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('metadata.base');
    expect(paths).toContain('metadata.watts');
  });

  it('applies the freeform schema (reserved-key guard) for OTHER', () => {
    const parsed = createPartSchema.safeParse({
      name: 'Mystery widget',
      kind: 'OTHER',
      metadata: { _provenance: 'nope' },
    });
    expect(parsed.success).toBe(false);
  });

  it('silently strips spec keys belonging to another kind', () => {
    const parsed = createPartSchema.safeParse({
      name: 'Furnace filter',
      kind: 'AIR_FILTER',
      metadata: { merv: 11, base: 'E26' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('purchaseLinks', () => {
  it('accepts http and https links with an optional label', () => {
    const parsed = createPartSchema.safeParse({
      name: 'Bulb',
      purchaseLinks: [
        { label: 'Amazon', url: 'https://example.com/dp/B0' },
        { url: 'http://example.com/x' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a bare host with no scheme', () => {
    const parsed = createPartSchema.safeParse({
      name: 'Bulb',
      purchaseLinks: [{ url: 'example.com' }],
    });
    expect(parsed.success).toBe(false);
  });

  // These render as user-clickable anchors. zod's `.url()` happily accepts
  // `javascript:` and `data:`, so the explicit http/https refinement is the
  // thing standing between a saved part and stored XSS.
  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>x</script>'])(
    'rejects the dangerous scheme %s',
    (url) => {
      const parsed = createPartSchema.safeParse({ name: 'Bulb', purchaseLinks: [{ url }] });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(JSON.stringify(parsed.error.issues)).toContain('http');
    },
  );

  it('rejects a non-http scheme such as ftp', () => {
    const parsed = createPartSchema.safeParse({
      name: 'Bulb',
      purchaseLinks: [{ url: 'ftp://example.com/x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('caps the list at 10 and the label at 80 chars', () => {
    const many = Array.from({ length: 11 }, () => ({ url: 'https://example.com' }));
    expect(createPartSchema.safeParse({ name: 'B', purchaseLinks: many }).success).toBe(false);
    expect(
      createPartSchema.safeParse({
        name: 'B',
        purchaseLinks: [{ label: 'x'.repeat(81), url: 'https://example.com' }],
      }).success,
    ).toBe(false);
  });
});

describe('updatePartSchema', () => {
  it('requires an id and allows every other field to be absent', () => {
    expect(updatePartSchema.safeParse({}).success).toBe(false);
    const parsed = updatePartSchema.safeParse({ id: 'p1' });
    expect(parsed.success).toBe(true);
  });

  it('still validates metadata when kind travels with it', () => {
    expect(
      updatePartSchema.safeParse({ id: 'p1', kind: 'BULB', metadata: { base: 'E27' } }).success,
    ).toBe(false);
    expect(
      updatePartSchema.safeParse({ id: 'p1', kind: 'BULB', metadata: { base: 'E26' } }).success,
    ).toBe(true);
  });

  // `.partial()` wraps a field in optional() but does not strip an inner
  // ZodDefault, so building the update schema off the *defaulted* object would
  // reset kind to OTHER and blank purchaseLinks on any update that omitted them.
  it('does not resurrect the create defaults', () => {
    const parsed = updatePartSchema.safeParse({ id: 'p1', name: 'Renamed' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ id: 'p1', name: 'Renamed' });
    expect('kind' in parsed.data).toBe(false);
    expect('purchaseLinks' in parsed.data).toBe(false);
  });

  it('leaves metadata alone when kind is absent (the action resolves it)', () => {
    const parsed = updatePartSchema.safeParse({ id: 'p1', metadata: { base: 'E27' } });
    expect(parsed.success).toBe(true);
  });
});

// The mirror of the items case fixed alongside this (#304's other half).
//
// A structured kind registers `metadata.<key>` controls and nothing as plain
// `metadata`, so a flat issue path renders nowhere — while
// applyActionFieldErrors still returns `applied: true` from its optimistic
// flat-key branch, suppressing the caller's fallback toast. Silent rejection.
//
// OTHER is the inverse: one registered `metadata` textarea, where a nested path
// would nest under it and render nothing.
describe('metadata issue paths match the registered field', () => {
  it('nests the path for a structured kind', () => {
    const result = createPartSchema.safeParse({
      name: 'Bulb',
      kind: 'BULB',
      metadata: { watts: -3 },
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('metadata.watts');
    expect(paths).not.toContain('metadata');
  });

  it('keeps the path flat for the freeform kind', () => {
    const result = createPartSchema.safeParse({
      name: 'Thing',
      kind: 'OTHER',
      metadata: { _provenance: { name: 'user' } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('metadata');
    expect(paths.filter((p) => p.startsWith('metadata.'))).toEqual([]);
  });
});
