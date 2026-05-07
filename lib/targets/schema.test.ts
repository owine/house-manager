import { describe, expect, it } from 'vitest';
import { targetSchema, targetsArraySchema } from '@/lib/targets/schema';

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
