// Metadata keys beginning with this prefix are internal bookkeeping (e.g.
// `_provenance`, written by conversational capture to record which fields
// were inferred rather than stated). They must never be settable by a user
// through a form, and must never leak into embedded/canonical text. Two
// peer consumers enforce this: `lib/categories.ts` (rejects them at the
// write path) and `lib/embedding/canonicalize.ts` (drops them from
// embedded text).
export const RESERVED_METADATA_PREFIX = '_';

export function isReservedMetadataKey(key: string): boolean {
  return key.startsWith(RESERVED_METADATA_PREFIX);
}
