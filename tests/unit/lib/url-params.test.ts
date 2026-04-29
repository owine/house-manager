import { describe, expect, it } from 'vitest';
import { parseListParams, serializeListParams } from '@/lib/url-params';

describe('parseListParams', () => {
  it('parses defaults from empty search params', () => {
    const result = parseListParams(new URLSearchParams(''));
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.sort).toBeUndefined();
    expect(result.q).toBeUndefined();
    expect(result.filters).toEqual({});
  });

  it('parses pagination, sort, q, and arbitrary filters', () => {
    const sp = new URLSearchParams(
      'page=3&pageSize=25&sort=createdAt&q=furnace&category=hvac,electrical&location=basement',
    );
    const result = parseListParams(sp);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(25);
    expect(result.sort).toBe('createdAt');
    expect(result.q).toBe('furnace');
    expect(result.filters.category).toEqual(['hvac', 'electrical']);
    expect(result.filters.location).toEqual(['basement']);
  });

  it('clamps invalid pagination values to safe defaults', () => {
    const sp = new URLSearchParams('page=-1&pageSize=99999');
    const result = parseListParams(sp);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
  });
});

describe('serializeListParams', () => {
  it('round-trips through parse', () => {
    const original = {
      page: 2,
      pageSize: 25,
      sort: 'name' as const,
      q: 'fridge',
      filters: { category: ['appliance'], location: ['kitchen'] },
    };
    const sp = serializeListParams(original);
    const parsed = parseListParams(new URLSearchParams(sp));
    expect(parsed).toEqual(original);
  });

  it('omits defaults', () => {
    const sp = serializeListParams({ page: 1, pageSize: 50, filters: {} });
    expect(sp).toBe('');
  });
});
