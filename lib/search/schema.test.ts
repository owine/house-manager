import { describe, expect, it } from 'vitest';
import { SEARCH_KINDS, searchQuerySchema } from './schema';

describe('searchQuerySchema', () => {
  it('accepts a minimal query', () => {
    const r = searchQuerySchema.safeParse({ q: 'furnace' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(20);
      expect(r.data.offset).toBe(0);
    }
  });

  it('accepts q + kind filter', () => {
    const r = searchQuerySchema.safeParse({ q: 'furnace', kind: 'item' });
    expect(r.success).toBe(true);
  });

  it('coerces limit/offset from strings (URLSearchParams flow)', () => {
    const r = searchQuerySchema.safeParse({ q: 'x', limit: '5', offset: '10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(5);
      expect(r.data.offset).toBe(10);
    }
  });

  it('rejects unknown kind', () => {
    const r = searchQuerySchema.safeParse({ q: 'x', kind: 'bogus' });
    expect(r.success).toBe(false);
  });

  it('rejects limit > 50', () => {
    const r = searchQuerySchema.safeParse({ q: 'x', limit: 51 });
    expect(r.success).toBe(false);
  });

  it('treats empty q as valid (read-path returns empty results without calling Meilisearch)', () => {
    const r = searchQuerySchema.safeParse({ q: '' });
    expect(r.success).toBe(true);
  });
});

describe('SEARCH_KINDS', () => {
  it('includes all 7 kinds in the documented order', () => {
    expect(SEARCH_KINDS).toEqual([
      'item',
      'vendor',
      'note',
      'service',
      'reminder',
      'attachment',
      'checklist',
    ]);
  });
});
