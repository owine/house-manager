// Metadata keys beginning with this prefix are internal bookkeeping (e.g.
// `_provenance`, written by conversational capture to record which fields
// were inferred rather than stated). They must never be settable by a user
// through a form, and must never leak into embedded/canonical text — see
// `lib/embedding/canonicalize.ts` (consumer) and `lib/categories.ts`
// (enforcement at the write path).
export const RESERVED_METADATA_PREFIX = '_';

export function isReservedMetadataKey(key: string): boolean {
  return key.startsWith(RESERVED_METADATA_PREFIX);
}
