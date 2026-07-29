import { describe, expect, it } from 'vitest';
import {
  partTargetSchema,
  targetSchema,
  targetsArraySchema,
  toTargetInputs,
} from '@/lib/targets/schema';

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
    expect(toTargetInputs([{ itemId: 'i1', systemId: null, partId: null }])).toEqual([
      { itemId: 'i1' },
    ]);
  });

  it('maps a system-linked row to { systemId }', () => {
    expect(toTargetInputs([{ itemId: null, systemId: 's1', partId: null }])).toEqual([
      { systemId: 's1' },
    ]);
  });

  it('drops a standalone (both-null) row instead of emitting { systemId: null }', () => {
    // Standalone chore targets carry no link; the form expects an empty
    // targets list so the server reconciles to the standalone shape. Emitting
    // { systemId: null } here would fail targetSchema's XOR refine and block
    // every save of a standalone chore.
    expect(toTargetInputs([{ itemId: null, systemId: null, partId: null }])).toEqual([]);
  });

  it('keeps links and drops standalone rows in a mixed list', () => {
    expect(
      toTargetInputs([
        { itemId: 'i1', systemId: null, partId: null },
        { itemId: null, systemId: null, partId: null },
        { itemId: null, systemId: 's1', partId: null },
      ]),
    ).toEqual([{ itemId: 'i1' }, { systemId: 's1' }]);
  });

  it('emits only rows that satisfy targetSchema', () => {
    for (const t of toTargetInputs([
      { itemId: 'i1', systemId: null, partId: null },
      { itemId: null, systemId: null, partId: null },
      { itemId: null, systemId: 's1', partId: null },
    ])) {
      expect(targetSchema.safeParse(t).success).toBe(true);
    }
  });
});

describe('partTargetSchema', () => {
  it('accepts a part-only target', () => {
    expect(partTargetSchema.safeParse({ partId: 'p1' }).success).toBe(true);
  });

  it('rejects two parents', () => {
    expect(partTargetSchema.safeParse({ partId: 'p1', itemId: 'i1' }).success).toBe(false);
  });

  it('rejects zero parents', () => {
    expect(partTargetSchema.safeParse({}).success).toBe(false);
  });
});

describe('targetSchema stays narrow', () => {
  // Warranties and incoming email import this one and keep a two-way XOR.
  // Widening it would let a part payload pass Zod and then fail at the DB.
  // The schema is non-strict, so `partId` is stripped as an unknown key and
  // the payload then fails the two-way XOR refine as a zero-parent target.
  it('does not accept a partId payload', () => {
    expect(targetSchema.safeParse({ partId: 'p1' }).success).toBe(false);
  });
});

describe('toTargetInputs with part rows', () => {
  it('keeps a part-only row', () => {
    expect(toTargetInputs([{ itemId: null, systemId: null, partId: 'p1' }])).toEqual([
      { partId: 'p1' },
    ]);
  });

  it('still drops the standalone chore row where all three are null', () => {
    expect(toTargetInputs([{ itemId: null, systemId: null, partId: null }])).toEqual([]);
  });
});
