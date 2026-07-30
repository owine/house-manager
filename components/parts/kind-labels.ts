import type { PartKind } from '@prisma/client';

/**
 * Display labels for `PartKind`. Presentation only — the enum members
 * themselves are the contract (see `PART_KINDS` in lib/parts/schema.ts).
 */
export const PART_KIND_LABELS: Record<PartKind, string> = {
  BULB: 'Bulb',
  AIR_FILTER: 'Air filter',
  WATER_FILTER: 'Water filter',
  BATTERY: 'Battery',
  BELT: 'Belt',
  FUSE: 'Fuse',
  CHEMICAL: 'Chemical',
  OTHER: 'Other',
};
