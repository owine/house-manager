import type { PartKind } from '@prisma/client';

/**
 * Display labels for `PartKind`. Presentation only — the enum members
 * themselves are the contract (see `PART_KINDS` in `./schema.ts`).
 *
 * Lives in `lib/`, not `components/`, because the search and embedding
 * canonicalizers render these labels into indexed text — and those run in the
 * worker, whose runtime image copies `lib/` but not `components/`. A label map
 * reachable from `worker/` must sit on the `lib/` side of that line.
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
