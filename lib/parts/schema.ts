import type { PartKind } from '@prisma/client';
import { z } from 'zod';

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

/**
 * `purchaseLinks` entries render as user-clickable anchors, so the scheme check
 * is a security property rather than a formatting nicety: zod's `.url()` accepts
 * `javascript:alert(1)` (and `data:`), which would be a stored-XSS vector the
 * moment a link is rendered as an `href`. Same guard as the external-attachment
 * URL in `lib/attachments/schema.ts`.
 */
const httpUrl = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//i.test(s), 'URL must use http:// or https://');

const purchaseLinkSchema = z.object({
  label: z.string().max(80).optional(),
  url: httpUrl,
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
 * The metadata UI registers one control per kind spec, but a nested issue path
 * (`metadata.watts`) that RHF cannot resolve fails silently — same trap as
 * issue #304 on items. The offending key moves into the message instead.
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
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    ctx.addIssue({
      code: 'custom',
      path: ['metadata'],
      message: path ? `${path}: ${issue.message}` : issue.message,
    });
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
