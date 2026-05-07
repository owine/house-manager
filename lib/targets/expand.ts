import type { TargetInput } from './schema';

interface SystemWithComponents {
  id: string;
  items: Array<{ id: string; archivedAt: Date | null }>;
}

/**
 * When the user checks a system in the picker, also yield all of its
 * active component items. Items already in `seed` are kept; the system
 * itself is included. Returns a deduplicated, ordered TargetInput[].
 */
export function expandSystemSelection(
  seed: TargetInput[],
  system: SystemWithComponents,
): TargetInput[] {
  const seen = new Set<string>(seed.map((t) => (t.itemId ? `i:${t.itemId}` : `s:${t.systemId}`)));
  const out: TargetInput[] = [...seed];
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
