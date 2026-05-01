import { z } from 'zod';

export const SEARCH_KINDS = [
  'item',
  'vendor',
  'note',
  'service',
  'reminder',
  'attachment',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export type SearchDocument = {
  // Composite primary key. Hyphen separator (NOT colon) — Meilisearch
  // primary keys are restricted to [A-Za-z0-9_-]. cuid2 ids are [0-9a-z]+
  // so the format is unambiguous (splittable on first hyphen).
  id: string; // e.g. "item-cmom..." | "reminder-cmoma..."

  kind: SearchKind;
  recordId: string;

  title: string;
  body: string;
  tags: string[];
  itemName: string;

  itemId: string | null;
  categorySlug: string | null;

  href: string;
  iconHint: string;
  updatedAt: number;
};

export const INDEX_SETTINGS = {
  searchableAttributes: ['title', 'itemName', 'body', 'tags'],
  filterableAttributes: ['kind', 'itemId', 'categorySlug'],
  sortableAttributes: ['updatedAt'],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  pagination: { maxTotalHits: 1000 },
} as const;

export const searchQuerySchema = z.object({
  q: z.string().max(200),
  kind: z.enum(SEARCH_KINDS).optional(),
  itemId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
