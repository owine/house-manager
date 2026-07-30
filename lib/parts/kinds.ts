import type { PartKind } from '@prisma/client';
import { z } from 'zod';

import { freeformMetadataSchema } from '@/lib/metadata/freeform';

/**
 * Per-kind spec schemas for a `Part`'s `metadata` blob.
 *
 * This mirrors `categoryConfigs` in `lib/categories.ts`, minus one layer of
 * indirection: item categories need a `typeField`/`visibility` pair because
 * their discriminator (`applianceType`, `vehicleType`, …) lives *inside* the
 * JSON blob. On a part, `kind` is a real enum column — it *is* the
 * discriminator — so each kind maps straight to a schema.
 *
 * Every field is optional: a user may know only the bulb's base and wattage.
 *
 * Three things that deliberately are NOT here:
 *   - `packQuantity`, `typicalCost`, `purchaseLinks` — columns on `Part`, not
 *     specs. They share the re-buy grain and would otherwise be duplicated
 *     across three kinds.
 *   - a unified `ratedLifespan` — lifespan stays per-kind with its own unit
 *     (`ratedHours` for bulbs, `ratedMonths` for filters). Unifying would
 *     force a unit field and buy nothing. Neither is a cadence; cadence lives
 *     on the `Reminder`.
 *   - a merged bulb "type" field — see below.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Bulb
// `base` (socket: E26) and `shape` (geometry: BR30) are separate on purpose.
// They vary independently — an E26 comes in A19, BR30 or PAR38 — and collapsing
// them loses exactly the information needed to re-buy the right bulb.
// ──────────────────────────────────────────────────────────────────────────────
const bulbSchema = z.object({
  base: z
    .enum(['E26', 'E12', 'E17', 'E39', 'GU10', 'GU24', 'GU5.3', 'G4', 'G9', 'other'])
    .optional(),
  shape: z
    .enum([
      'A19',
      'A21',
      'BR30',
      'BR40',
      'PAR20',
      'PAR30',
      'PAR38',
      'MR16',
      'G25',
      'ST19',
      'S14',
      'T8',
      'other',
    ])
    .optional(),
  technology: z.enum(['LED', 'incandescent', 'halogen', 'CFL', 'fluorescent']).optional(),
  watts: z.number().positive().optional(),
  wattEquivalent: z.number().positive().optional(),
  lumens: z.number().nonnegative().optional(),
  colorTempK: z.number().positive().optional(),
  cri: z.number().nonnegative().optional(),
  dimmable: z.boolean().optional(),
  voltage: z.number().positive().optional(),
  ratedHours: z.number().nonnegative().optional(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Air filter
// `nominalSize` is what's printed on the box and what you search for
// ("20x25x1"); `actualSize` is what it measures ("19.5x24.5x0.75"). Both are
// free text — sizes come in fractional and metric forms.
// MERV, MPR and FPR are three competing rating scales (ASHRAE, 3M, Home Depot);
// a filter carries whichever its maker prints, so all three are kept.
// ──────────────────────────────────────────────────────────────────────────────
const airFilterSchema = z.object({
  nominalSize: z.string().optional(),
  actualSize: z.string().optional(),
  merv: z.number().nonnegative().optional(),
  mpr: z.number().nonnegative().optional(),
  fpr: z.number().nonnegative().optional(),
  pleated: z.boolean().optional(),
  ratedMonths: z.number().nonnegative().optional(),
});

const waterFilterSchema = z.object({
  cartridgeType: z.enum(['ro-membrane', 'sediment', 'carbon-block', 'fridge-inline']).optional(),
  micronRating: z.number().nonnegative().optional(),
  capacityGallons: z.number().nonnegative().optional(),
  ratedMonths: z.number().nonnegative().optional(),
});

const batterySchema = z.object({
  size: z
    .enum(['AA', 'AAA', 'C', 'D', '9V', 'CR2032', 'CR2450', 'CR123A', '18650', 'other'])
    .optional(),
  chemistry: z
    .enum(['alkaline', 'lithium', 'lithium-ion', 'NiMH', 'silver-oxide', 'other'])
    .optional(),
  voltage: z.number().positive().optional(),
  capacityMah: z.number().nonnegative().optional(),
  rechargeable: z.boolean().optional(),
});

// Belt sizing is a mess of vendor conventions (V-belt "4L360", serpentine
// "6PK1085", timing "150XL037"), so length and profile stay free text.
const beltSchema = z.object({
  beltType: z.string().optional(),
  length: z.string().optional(),
  profile: z.string().optional(),
});

const fuseSchema = z.object({
  amps: z.number().positive().optional(),
  voltage: z.number().positive().optional(),
  fuseType: z.string().optional(),
  fastBlow: z.boolean().optional(),
});

// Softener salt, pool chlorine, descaler. `concentration` and `containerSize`
// are free text — units vary wildly ("99.8% NaCl", "40lb bag", "1 gal").
const chemicalSchema = z.object({
  form: z.enum(['pellet', 'crystal', 'liquid', 'tablet', 'powder']).optional(),
  concentration: z.string().optional(),
  containerSize: z.string().optional(),
});

export const partKindConfigs: Record<PartKind, z.ZodTypeAny> = {
  BULB: bulbSchema,
  AIR_FILTER: airFilterSchema,
  WATER_FILTER: waterFilterSchema,
  BATTERY: batterySchema,
  BELT: beltSchema,
  FUSE: fuseSchema,
  CHEMICAL: chemicalSchema,
  OTHER: freeformMetadataSchema,
};

export function partKindSchemaFor(kind: PartKind): z.ZodTypeAny {
  return partKindConfigs[kind] ?? freeformMetadataSchema;
}
