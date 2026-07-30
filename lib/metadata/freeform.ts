import { z } from 'zod';

import { isReservedMetadataKey, RESERVED_METADATA_PREFIX } from './reserved-keys';

// Freeform metadata for unknown categories or `other` — accepts any
// key/value of a few primitive types. Items predating a schema upgrade
// keep working because their stored `metadata` blob still parses here.
//
// Keys starting with `RESERVED_METADATA_PREFIX` are rejected: that prefix is
// reserved for internal bookkeeping (e.g. `_provenance`, written directly via
// Prisma by conversational capture, never through this schema) and
// `canonicalizeItem` silently drops such keys from embedded text. Without
// this guard a user typing `{"_notes": "..."}` here would save successfully
// but become unfindable via search/Ask with no indication why.
//
// The issue is emitted with NO path (i.e. on the record root), not per-key.
// This schema backs exactly one registered form field — the whole blob is a
// single JSON textarea (`ItemMetadataFields.tsx`'s freeform fallback), not
// one field per key like the structured category schemas. A per-key path
// (e.g. `path: [key]`) produces a form error at `metadata.<key>`, which
// nothing renders — RHF nests it under `errors.metadata` without ever
// setting `errors.metadata.message`, so `FormMessage` on the one registered
// `metadata` field sees nothing and silently swallows the rejection.
export const freeformMetadataSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .superRefine((value, ctx) => {
    const reserved = Object.keys(value).filter(isReservedMetadataKey);
    if (reserved.length === 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${reserved.map((k) => `"${k}"`).join(', ')} ${reserved.length === 1 ? 'is' : 'are'} reserved — keys starting with "${RESERVED_METADATA_PREFIX}" are for internal use only`,
    });
  });
