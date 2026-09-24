// Metadata keys beginning with this prefix are internal bookkeeping (e.g.
// `_provenance`, written by conversational capture to record which fields
// were inferred rather than stated). They must never be settable by a user
// through a form, must never leak into embedded/canonical text, and must
// never be rendered.
//
// Four enforcement points, and this list is a CHECKLIST TO EXTEND, not a
// description of a finished job:
//   - write path      — `lib/categories.ts` rejects them
//   - embedding path  — `lib/embedding/canonicalize.ts` drops them
//   - read path       — `visibleMetadataEntries` below, used by every view
//                       that enumerates a metadata blob
//   - edit path       — `ItemForm` / `PartForm` strip them from their default
//                       values (`stripReservedMetadata`), and `updateItem` /
//                       `updatePart` re-attach the STORED ones on save
//                       (`withStoredReservedMetadata`). They are server-owned.
//
// The read path was missing until #328, which is how `_provenance` came to
// render as a raw JSON row on the item detail page and — worse — to pre-fill
// the freeform JSON textarea with a value the write path then rejected,
// making AI-captured items unsaveable on a field the user never touched.
//
// Any new boundary that enumerates a metadata blob needs the filter.
// `Object.entries(metadata)` is the grep that finds them.
export const RESERVED_METADATA_PREFIX = '_';

export function isReservedMetadataKey(key: string): boolean {
  return key.startsWith(RESERVED_METADATA_PREFIX);
}

/**
 * The user-visible entries of a metadata blob, with reserved keys removed.
 *
 * Returns entries rather than an object so callers can check `.length` for an
 * "is there anything to show?" test without rebuilding the object — an empty
 * card with a heading and no rows is its own bug. Callers needing an object
 * can wrap in `Object.fromEntries`.
 *
 * Takes `unknown` because `metadata` is a Prisma `Json` column: it is typed as
 * `JsonValue` and may legitimately be null or a non-object.
 */
export function visibleMetadataEntries(metadata: unknown): [string, unknown][] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  return Object.entries(metadata as Record<string, unknown>).filter(
    ([key]) => !isReservedMetadataKey(key),
  );
}

/**
 * A metadata blob with reserved keys removed, as an object — the shape a
 * form's default values need.
 *
 * Hiding them only in the rendered textarea is not enough: the textarea is
 * uncontrolled, so a hidden key still rides along in the form's field value
 * and an untouched save submits it.
 */
export function stripReservedMetadata(metadata: unknown): Record<string, unknown> {
  return Object.fromEntries(visibleMetadataEntries(metadata));
}

/**
 * Re-attach the reserved keys of the STORED blob to a validated incoming one.
 *
 * Reserved keys are server-owned. Forms never carry them, freeform validation
 * rejects them, and every structured schema is a plain `z.object` that strips
 * them, so an update action that wrote the validated blob verbatim dropped
 * `_provenance` on every edit. The stored keys always win, and any reserved
 * key the client sent is discarded — a client can never set one.
 */
export function withStoredReservedMetadata(
  next: unknown,
  stored: unknown,
): Record<string, unknown> {
  const reserved =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? Object.entries(stored as Record<string, unknown>).filter(([key]) =>
          isReservedMetadataKey(key),
        )
      : [];
  return { ...stripReservedMetadata(next), ...Object.fromEntries(reserved) };
}
