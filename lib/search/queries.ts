import { searchIndex } from './client';
import { HL_CLOSE, HL_OPEN } from './highlight';
import type { SearchDocument, SearchQuery } from './schema';

export type SearchHit = SearchDocument & {
  _formatted?: { title?: string; body?: string };
};

export type SearchResult = {
  hits: SearchHit[];
  total: number;
  facets: { kind?: Record<string, number> };
};

export async function searchAll(query: SearchQuery): Promise<SearchResult> {
  const q = query.q.trim();
  if (q === '') {
    return { hits: [], total: 0, facets: {} };
  }

  const allFilters: string[] = [];
  if (query.kind) allFilters.push(`kind = ${query.kind}`);
  if (query.itemId) allFilters.push(`itemId = "${query.itemId.replace(/"/g, '\\"')}"`);

  const idx = searchIndex();

  // Use two parallel searches: one for hits (with all filters), one for facets
  // (without kind filter). This ensures the user can see facet counts for other
  // kinds even when a kind filter is applied, enabling navigation via facet pills.
  const facetFilters = allFilters.filter((f) => !f.startsWith('kind = '));

  const [hitsRes, facetsRes] = await Promise.all([
    idx.search<SearchHit>(q, {
      limit: query.limit,
      offset: query.offset,
      filter: allFilters.length > 0 ? allFilters.join(' AND ') : undefined,
      attributesToHighlight: ['title', 'body'],
      highlightPreTag: HL_OPEN,
      highlightPostTag: HL_CLOSE,
    }),
    idx.search<SearchHit>(q, {
      filter: facetFilters.length > 0 ? facetFilters.join(' AND ') : undefined,
      facets: ['kind'],
    }),
  ]);

  return {
    hits: hitsRes.hits,
    total: hitsRes.estimatedTotalHits ?? hitsRes.hits.length,
    facets: { kind: (facetsRes.facetDistribution?.kind as Record<string, number>) ?? {} },
  };
}
