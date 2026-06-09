import { describe, expect, it } from 'vitest';
import { targetSchema, targetsArraySchema, toTargetInputs } from '@/lib/targets/schema';

describe('targetSchema', () => {
  it('accepts itemId only', () => {
    expect(targetSchema.safeParse({ itemId: 'x' }).success).toBe(true);
  });

  it('accepts systemId only', () => {
    expect(targetSchema.safeParse({ systemId: 'y' }).success).toBe(true);
  });

  it('rejects when both itemId and systemId are set', () => {
    const result = targetSchema.safeParse({ itemId: 'x', systemId: 'y' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('exactly one of itemId / systemId must be set');
    }
  });

  it('rejects when neither is set', () => {
    const result = targetSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('exactly one of itemId / systemId must be set');
    }
  });

  it('rejects when both are explicitly null', () => {
    const result = targetSchema.safeParse({ itemId: null, systemId: null });
    expect(result.success).toBe(false);
  });
});

describe('targetsArraySchema', () => {
  it('rejects an empty array', () => {
    expect(targetsArraySchema.safeParse([]).success).toBe(false);
  });

  it('accepts a single-element array', () => {
    expect(targetsArraySchema.safeParse([{ itemId: 'a' }]).success).toBe(true);
  });

  it('accepts a multi-element array of mixed targets', () => {
    const result = targetsArraySchema.safeParse([
      { itemId: 'a' },
      { systemId: 'b' },
      { itemId: 'c' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects when any element is invalid', () => {
    const result = targetsArraySchema.safeParse([{ itemId: 'a' }, { itemId: 'b', systemId: 'c' }]);
    expect(result.success).toBe(false);
  });
});

describe('toTargetInputs', () => {
  it('maps an item-linked row to { itemId }', () => {
    expect(toTargetInputs([{ itemId: 'i1', systemId: null }])).toEqual([{ itemId: 'i1' }]);
  });

  it('maps a system-linked row to { systemId }', () => {
    expect(toTargetInputs([{ itemId: null, systemId: 's1' }])).toEqual([{ systemId: 's1' }]);
  });

  it('drops a standalone (both-null) row instead of emitting { systemId: null }', () => {
    // Standalone chore targets carry no link; the form expects an empty
    // targets list so the server reconciles to the standalone shape. Emitting
    // { systemId: null } here would fail targetSchema's XOR refine and block
    // every save of a standalone chore.
    expect(toTargetInputs([{ itemId: null, systemId: null }])).toEqual([]);
  });

  it('keeps links and drops standalone rows in a mixed list', () => {
    expect(
      toTargetInputs([
        { itemId: 'i1', systemId: null },
        { itemId: null, systemId: null },
        { itemId: null, systemId: 's1' },
      ]),
    ).toEqual([{ itemId: 'i1' }, { systemId: 's1' }]);
  });

  it('emits only rows that satisfy targetSchema', () => {
    for (const t of toTargetInputs([
      { itemId: 'i1', systemId: null },
      { itemId: null, systemId: null },
      { itemId: null, systemId: 's1' },
    ])) {
      expect(targetSchema.safeParse(t).success).toBe(true);
    }
  });
});
