import type { PartTargetInput } from './schema';

interface SystemWithComponents {
  id: string;
  items: Array<{ id: string; archivedAt: Date | null }>;
}

/** Dedupe key. Must cover all three parents: keying a part row as
 * `s:${t.systemId}` would yield `s:undefined` and collide with system rows. */
const keyOf = (t: PartTargetInput) =>
  t.itemId ? `i:${t.itemId}` : t.systemId ? `s:${t.systemId}` : `p:${t.partId}`;

/**
 * When the user checks a system in the picker, also yield all of its
 * active component items. Items already in `seed` are kept; the system
 * itself is included. Returns a deduplicated, ordered PartTargetInput[].
 *
 * Deliberately does NOT expand a system to its parts: items are *components*
 * of a system, parts are *consumed by* it. "Serviced the furnace" must not
 * silently claim the filter was replaced.
 */
export function expandSystemSelection(
  seed: PartTargetInput[],
  system: SystemWithComponents,
): PartTargetInput[] {
  const seen = new Set<string>(seed.map(keyOf));
  const out: PartTargetInput[] = [...seed];
  if (!seen.has(`s:${system.id}`)) {
    out.push({ systemId: system.id });
    seen.add(`s:${system.id}`);
  }
  for (const item of system.items) {
    if (item.archivedAt) continue;
    const key = `i:${item.id}`;
    if (seen.has(key)) continue;
    out.push({ itemId: item.id });
    seen.add(key);
  }
  return out;
}
