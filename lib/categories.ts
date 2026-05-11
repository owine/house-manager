import { z } from 'zod';

// Freeform metadata for unknown categories or `other` — accepts any
// key/value of a few primitive types. Items predating a schema upgrade
// keep working because their stored `metadata` blob still parses here.
const freeformMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/**
 * Per-category metadata config.
 *
 * `schema` is the union of every field that *could* apply to any item in
 * this category — kept wide so a fridge and a microwave can both be
 * categorised as `appliance` without forcing one into the other's shape.
 *
 * `typeField` names a discriminator key inside the schema (e.g.
 * `applianceType`). When set, the form's metadata card uses the live
 * value of that field to decide which other fields to render.
 *
 * `visibility[fieldName]` lists the `typeField` values for which
 * `fieldName` should appear. Fields *not* listed in `visibility` are
 * always visible. Before the user picks a `typeField` value, only fields
 * without a visibility rule render (so the form isn't blank but doesn't
 * dump 20 unrelated rows either).
 */
type CategoryConfig = {
  schema: z.ZodTypeAny;
  typeField?: string;
  visibility?: Record<string, string[]>;
};

// ──────────────────────────────────────────────────────────────────────────────
// Appliance
// One bucket spans fridges, washers, dryers, dishwashers, ovens, microwaves,
// range hoods, water heaters, garbage disposals. Each has its own relevant
// specs; the union below covers them all, and `visibility` filters per type.
// ──────────────────────────────────────────────────────────────────────────────
const applianceSchema = z.object({
  applianceType: z
    .enum([
      'refrigerator',
      'freezer',
      'wine-fridge',
      'ice-maker',
      'dishwasher',
      'washer',
      'dryer',
      'range',
      'cooktop',
      'wall-oven',
      'microwave',
      'range-hood',
      'water-heater',
      'garbage-disposal',
      'trash-compactor',
      'other',
    ])
    .optional(),
  fuelType: z.enum(['electric', 'gas', 'propane', 'dual-fuel']).optional(),
  voltage: z.number().positive().optional(),
  amperage: z.number().positive().optional(),
  wattage: z.number().positive().optional(),
  btu: z.number().nonnegative().optional(),
  capacityCuFt: z.number().nonnegative().optional(),
  capacityLbs: z.number().nonnegative().optional(),
  capacityGallons: z.number().nonnegative().optional(),
  widthInches: z.number().positive().optional(),
  depthInches: z.number().positive().optional(),
  heightInches: z.number().positive().optional(),
  color: z.string().optional(),
  energyStarCertified: z.boolean().optional(),
  waterLineRequired: z.boolean().optional(),
  drainRequired: z.boolean().optional(),
  ventType: z.enum(['ducted', 'recirculating', 'exterior', 'none']).optional(),
  decibelRating: z.number().positive().optional(),
  filterPart: z.string().optional(),
});

const applianceVisibility: Record<string, string[]> = {
  voltage: ['range', 'cooktop', 'wall-oven', 'dryer', 'water-heater'],
  amperage: ['range', 'cooktop', 'wall-oven', 'dryer', 'water-heater'],
  wattage: ['microwave', 'range-hood', 'garbage-disposal'],
  btu: ['range', 'cooktop', 'wall-oven'],
  capacityCuFt: ['refrigerator', 'freezer', 'wine-fridge', 'washer', 'dryer'],
  capacityLbs: ['washer', 'dryer'],
  capacityGallons: ['water-heater'],
  energyStarCertified: [
    'refrigerator',
    'freezer',
    'wine-fridge',
    'dishwasher',
    'washer',
    'dryer',
    'water-heater',
  ],
  waterLineRequired: ['refrigerator', 'dishwasher', 'washer', 'ice-maker'],
  drainRequired: ['dishwasher', 'washer'],
  ventType: ['dryer', 'range-hood'],
  decibelRating: ['dishwasher', 'range-hood'],
  filterPart: ['refrigerator', 'range-hood', 'dishwasher'],
  // applianceType, fuelType, color, width/depth/height: always visible
};

// ──────────────────────────────────────────────────────────────────────────────
// HVAC
// Central AC vs furnace vs heat pump vs mini-split vs window unit vs boiler
// all live here. Different efficiency ratings + refrigerant relevance.
// ──────────────────────────────────────────────────────────────────────────────
const hvacSchema = z.object({
  hvacType: z
    .enum([
      'central-ac',
      'central-furnace',
      'heat-pump',
      'mini-split',
      'window-unit',
      'portable-ac',
      'boiler',
      'radiator',
      'baseboard-heater',
      'humidifier',
      'dehumidifier',
      'thermostat',
      'air-purifier',
      'ventilator',
      'other',
    ])
    .optional(),
  fuelType: z.enum(['electric', 'gas', 'propane', 'oil', 'heat-pump']).optional(),
  btu: z.number().nonnegative().optional(),
  tonnage: z.number().positive().optional(),
  seer: z.number().positive().optional(),
  seer2: z.number().positive().optional(),
  hspf: z.number().positive().optional(),
  afue: z.number().positive().optional(),
  refrigerantType: z.string().optional(),
  filterSize: z.string().optional(),
  zoneCount: z.number().positive().int().optional(),
});

const hvacVisibility: Record<string, string[]> = {
  btu: [
    'central-ac',
    'central-furnace',
    'heat-pump',
    'mini-split',
    'window-unit',
    'portable-ac',
    'boiler',
  ],
  tonnage: ['central-ac', 'heat-pump', 'mini-split'],
  seer: ['central-ac', 'heat-pump', 'mini-split', 'window-unit', 'portable-ac'],
  seer2: ['central-ac', 'heat-pump', 'mini-split'],
  hspf: ['heat-pump', 'mini-split'],
  afue: ['central-furnace', 'boiler'],
  refrigerantType: ['central-ac', 'heat-pump', 'mini-split', 'window-unit', 'portable-ac'],
  filterSize: ['central-ac', 'central-furnace', 'heat-pump', 'mini-split', 'air-purifier'],
  zoneCount: ['central-ac', 'central-furnace', 'heat-pump', 'mini-split'],
};

// ──────────────────────────────────────────────────────────────────────────────
// Vehicle
// Cars, trucks, SUVs, motorcycles, ATVs/UTVs, RVs, trailers, boats, golf carts,
// e-bikes. Mileage matters for road vehicles; engine-hours matter for boats /
// ATVs / RVs. VIN/oil/tire fields gate on the relevant subset.
// ──────────────────────────────────────────────────────────────────────────────
const vehicleSchema = z.object({
  vehicleType: z
    .enum([
      'car',
      'truck',
      'suv',
      'motorcycle',
      'atv-utv',
      'rv',
      'trailer',
      'boat',
      'golf-cart',
      'e-bike',
      'other',
    ])
    .optional(),
  vin: z.string().length(17).optional(),
  licensePlate: z.string().optional(),
  fuelType: z.enum(['gasoline', 'diesel', 'electric', 'hybrid', 'propane']).optional(),
  mileage: z.number().nonnegative().optional(),
  engineHours: z.number().nonnegative().optional(),
  engineDisplacement: z.string().optional(),
  tireSize: z.string().optional(),
  batteryGroupSize: z.string().optional(),
  oilType: z.string().optional(),
  oilCapacityQuarts: z.number().positive().optional(),
  color: z.string().optional(),
});

const vehicleVisibility: Record<string, string[]> = {
  vin: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv'],
  mileage: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv'],
  engineHours: ['boat', 'atv-utv', 'rv'],
  engineDisplacement: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv', 'boat'],
  tireSize: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv', 'trailer'],
  batteryGroupSize: ['car', 'truck', 'suv', 'motorcycle', 'rv', 'boat'],
  oilType: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv', 'boat'],
  oilCapacityQuarts: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv', 'boat'],
  fuelType: ['car', 'truck', 'suv', 'motorcycle', 'atv-utv', 'rv', 'boat', 'golf-cart'],
  // licensePlate, color: always visible
};

// ──────────────────────────────────────────────────────────────────────────────
// Tool
// Shop/garage gear (drills, saws, generators, compressors, pressure washers,
// welders, shop vacs, ladders, jacks) and lawn equipment (mowers, trimmers,
// blowers, edgers, leaf vacuums). The user opted to keep lawn gear here rather
// than under landscaping, so this bucket is the catch-all for "tools and
// powered equipment."
// ──────────────────────────────────────────────────────────────────────────────
const toolSchema = z.object({
  toolType: z
    .enum([
      'power-tool',
      'hand-tool',
      'lawn-mower',
      'lawn-trimmer',
      'blower',
      'edger',
      'leaf-vacuum',
      'generator',
      'air-compressor',
      'pressure-washer',
      'welder',
      'shop-vac',
      'ladder',
      'jack',
      'other',
    ])
    .optional(),
  powerSource: z.enum(['battery', 'corded', 'gas', 'manual']).optional(),
  voltage: z.number().positive().optional(),
  batteryPlatform: z.string().optional(),
  amperage: z.number().positive().optional(),
  maxPsi: z.number().positive().optional(),
  tankGallons: z.number().positive().optional(),
  outputWatts: z.number().positive().optional(),
  weightCapacityLbs: z.number().positive().optional(),
  bladeSize: z.string().optional(),
  chuckSize: z.string().optional(),
  cuttingWidthInches: z.number().positive().optional(),
  bagCapacityBushels: z.number().positive().optional(),
});

const toolVisibility: Record<string, string[]> = {
  voltage: ['power-tool', 'lawn-mower', 'lawn-trimmer', 'blower', 'edger', 'leaf-vacuum'],
  batteryPlatform: ['power-tool', 'lawn-mower', 'lawn-trimmer', 'blower', 'edger', 'leaf-vacuum'],
  amperage: ['power-tool', 'pressure-washer', 'shop-vac', 'welder'],
  maxPsi: ['air-compressor', 'pressure-washer'],
  tankGallons: ['air-compressor', 'shop-vac'],
  outputWatts: ['generator', 'welder'],
  weightCapacityLbs: ['ladder', 'jack'],
  bladeSize: ['power-tool', 'lawn-mower'],
  chuckSize: ['power-tool'],
  cuttingWidthInches: ['lawn-mower', 'lawn-trimmer', 'edger'],
  bagCapacityBushels: ['lawn-mower', 'leaf-vacuum'],
  // powerSource: always visible (it's the cross-cutting "how is this powered?")
};

// ──────────────────────────────────────────────────────────────────────────────
// Landscaping
// Plants (trees, shrubs, beds), lawn areas, irrigation, fences, hardscape,
// deck/retaining-wall. Lawn equipment lives under `tool`.
// `coverageArea` (string) is kept for back-compat with anything already
// recorded; the new numeric `coverageAreaSqFt` is preferred going forward.
// ──────────────────────────────────────────────────────────────────────────────
const landscapingSchema = z.object({
  landscapingType: z
    .enum([
      'tree',
      'shrub',
      'perennial-bed',
      'garden-bed',
      'mulch-bed',
      'lawn-area',
      'irrigation-zone',
      'irrigation-controller',
      'sprinkler-head',
      'fence-section',
      'deck',
      'hardscape',
      'retaining-wall',
      'other',
    ])
    .optional(),
  coverageArea: z.string().optional(),
  coverageAreaSqFt: z.number().nonnegative().optional(),
  speciesOrCultivar: z.string().optional(),
  plantedDate: z.string().optional(),
  zoneCount: z.number().int().positive().optional(),
  sprinklerHeadCount: z.number().int().positive().optional(),
  fenceMaterial: z
    .enum(['wood', 'vinyl', 'chain-link', 'aluminum', 'wrought-iron', 'composite', 'other'])
    .optional(),
  fenceLinearFeet: z.number().positive().optional(),
  fenceHeightFeet: z.number().positive().optional(),
  hardscapeMaterial: z.string().optional(),
});

const landscapingVisibility: Record<string, string[]> = {
  speciesOrCultivar: ['tree', 'shrub', 'perennial-bed', 'garden-bed'],
  plantedDate: ['tree', 'shrub', 'perennial-bed', 'garden-bed', 'lawn-area'],
  coverageAreaSqFt: [
    'lawn-area',
    'perennial-bed',
    'garden-bed',
    'mulch-bed',
    'hardscape',
    'deck',
    'retaining-wall',
  ],
  zoneCount: ['irrigation-controller'],
  sprinklerHeadCount: ['irrigation-zone', 'irrigation-controller'],
  fenceMaterial: ['fence-section'],
  fenceLinearFeet: ['fence-section'],
  fenceHeightFeet: ['fence-section'],
  hardscapeMaterial: ['hardscape', 'retaining-wall', 'deck'],
  // coverageArea (string, legacy): always visible
};

// ──────────────────────────────────────────────────────────────────────────────
// The rest — unchanged shape for now. Same widening pattern can apply later.
// ──────────────────────────────────────────────────────────────────────────────
export const categoryConfigs: Record<string, CategoryConfig> = {
  appliance: {
    schema: applianceSchema,
    typeField: 'applianceType',
    visibility: applianceVisibility,
  },
  hvac: {
    schema: hvacSchema,
    typeField: 'hvacType',
    visibility: hvacVisibility,
  },
  plumbing: {
    schema: z.object({
      capacityGallons: z.number().nonnegative().optional(),
      fuelType: z.enum(['electric', 'gas']).optional(),
    }),
  },
  electrical: {
    schema: z.object({
      panelBrand: z.string().optional(),
      amps: z.number().positive().optional(),
    }),
  },
  exterior: {
    schema: z.object({
      material: z.string().optional(),
      squareFootage: z.number().nonnegative().optional(),
    }),
  },
  vehicle: {
    schema: vehicleSchema,
    typeField: 'vehicleType',
    visibility: vehicleVisibility,
  },
  tool: {
    schema: toolSchema,
    typeField: 'toolType',
    visibility: toolVisibility,
  },
  landscaping: {
    schema: landscapingSchema,
    typeField: 'landscapingType',
    visibility: landscapingVisibility,
  },
  other: {
    schema: freeformMetadataSchema,
  },
};

export function metadataSchemaFor(slug: string): z.ZodTypeAny {
  return categoryConfigs[slug]?.schema ?? freeformMetadataSchema;
}

export function categoryConfigFor(slug: string): CategoryConfig | undefined {
  return categoryConfigs[slug];
}

/**
 * Given a category slug and the current value of its discriminator field,
 * returns the list of metadata field names that should render. Fields with
 * no visibility rule are always included. Before the user picks a type,
 * the discriminator field itself plus any always-on fields render.
 */
export function visibleMetadataFields(
  slug: string,
  shapeKeys: string[],
  currentTypeValue: string | undefined,
): string[] {
  const config = categoryConfigs[slug];
  if (!config?.typeField || !config.visibility) return shapeKeys;
  const { typeField, visibility } = config;
  return shapeKeys.filter((key) => {
    if (key === typeField) return true;
    const allowed = visibility[key];
    if (!allowed) return true;
    if (!currentTypeValue) return false;
    return allowed.includes(currentTypeValue);
  });
}
