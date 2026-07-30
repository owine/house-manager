import type { PartKind } from '@prisma/client';
import { z } from 'zod';

import { httpUrlSchema } from '@/lib/http-url';
import { freeformMetadataSchema } from '@/lib/metadata/freeform';

import { partKindSchemaFor } from './kinds';

export const PART_KINDS = [
  'BULB',
  'AIR_FILTER',
  'WATER_FILTER',
  'BATTERY',
  'BELT',
  'FUSE',
  'CHEMICAL',
  'OTHER',
] as const satisfies readonly PartKind[];

const purchaseLinkSchema = z.object({
  label: z.string().max(80).optional(),
  url: httpUrlSchema,
});

/**
 * Field shapes *without* `.default()`.
 *
 * The defaults are attached only on the create schema: `.partial()` wraps a
 * field in `optional()` but does **not** strip an inner `ZodDefault`, so a
 * partial built from the defaulted object would silently resurrect
 * `kind: 'OTHER'` and `purchaseLinks: []` on an update that never mentioned
 * them — resetting a bulb's kind and wiping its purchase links.
 */
const partFieldsCore = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  kind: z.enum(PART_KINDS),
  location: z.string().max(200).optional().nullable(),
  manufacturer: z.string().max(200).optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  sku: z.string().max(200).optional().nullable(),
  typicalCost: z.coerce.number().nonnegative().optional().nullable(),
  packQuantity: z.coerce.number().int().positive().optional().nullable(),
  purchaseLinks: z.array(purchaseLinkSchema).max(10),
  metadata: z.unknown(),
  notes: z.string().max(20_000).optional().nullable(),
});

/**
 * Collapse a per-kind metadata failure onto the `metadata` field.
 *
 * The issue path has to match a field the UI actually registers, and that
 * differs by kind — the same trap as issue #304 on items, in both directions.
 *
 * `OTHER` (freeform) renders ONE `metadata` JSON textarea, so a flat path
 * renders inline and a nested one would nest under it and show nothing.
 *
 * Every structured kind renders `metadata.<key>` controls and registers NOTHING
 * as plain `metadata`, so a flat path renders nowhere — while
 * `applyActionFieldErrors` still returns `applied: true` from its optimistic
 * flat-key branch, which suppresses the caller's fallback toast. Silent.
 * A nested path is safe there: the helper sets it on the registered field and
 * also mirrors it to the root banner.
 */
function refineMetadata(
  value: { kind?: PartKind; metadata?: unknown },
  ctx: z.RefinementCtx,
): void {
  // On an update without `kind`, the caller has to resolve the stored kind and
  // validate there; the schema alone cannot know which spec applies.
  if (value.kind === undefined || value.metadata === undefined) return;
  const result = partKindSchemaFor(value.kind).safeParse(value.metadata ?? {});
  if (result.success) return;

  const structured = partKindSchemaFor(value.kind) !== freeformMetadataSchema;
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    if (structured && path) {
      ctx.addIssue({ code: 'custom', path: ['metadata', ...issue.path], message: issue.message });
    } else {
      ctx.addIssue({
        code: 'custom',
        path: ['metadata'],
        message: path ? `${path}: ${issue.message}` : issue.message,
      });
    }
  }
}

export const createPartSchema = partFieldsCore
  .extend({
    kind: z.enum(PART_KINDS).default('OTHER'),
    purchaseLinks: z.array(purchaseLinkSchema).max(10).default([]),
    metadata: z.unknown().default({}),
  })
  .superRefine(refineMetadata);

export const updatePartSchema = partFieldsCore
  .partial()
  .extend({ id: z.string().min(1) })
  .superRefine(refineMetadata);

export type CreatePartInput = z.infer<typeof createPartSchema>;
