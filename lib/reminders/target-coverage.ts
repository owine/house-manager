import type { CalendarDate } from '@/lib/time/tz';

/**
 * "Naming the system already says everything the component rows say."
 *
 * A reminder may legitimately target both a System and the Items that belong to
 * it — `targetsArraySchema` allows the array, and the XOR check constraint is
 * per-target, not per-reminder. Rendering all of them repeats the same fact
 * once per component. This module is the single definition of which item
 * targets that makes redundant.
 *
 * It is deliberately shape-agnostic: the reminder email, the digest grouper and
 * <TargetsChips> each hold a different row type, and each projects into
 * `CoverageFacts` rather than converging on a common row.
 */
export type CoverageFacts = {
  /** id of the System this target *is*; null for item targets. */
  systemId: string | null;
  /**
   * id of the System owning the Item this target *is*. Null when the target is
   * a system, or when the item belongs to no system.
   */
  itemSystemId: string | null;
  /**
   * This target's own due date. Omit to skip the date check entirely — callers
   * with no date context (<TargetsChips>) and callers whose scope already
   * guarantees one shared date (digest entries) both leave it undefined.
   * Populate it for all targets in a call or none — mixing is legal but means
   * the undated rows suppress unconditionally.
   */
  dueOn?: CalendarDate;
};

/**
 * Calendar dates are stored at UTC midnight, so equality is exact `getTime()`
 * comparison — no timezone is involved. See `lib/time/tz.ts`.
 *
 * An omitted date on *either* side agrees with anything: absence means "this
 * caller is not making a claim about dates", not "this target has no date".
 */
function datesAgree(a: CalendarDate | undefined, b: CalendarDate | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a.getTime() === b.getTime();
}

/**
 * Drop item targets whose parent system is also targeted on the same day.
 *
 * System targets are never candidates for removal, so any suppression implies a
 * surviving system target — this can never empty a non-empty list.
 */
export function dropSystemCoveredItems<T>(
  targets: readonly T[],
  /** Called exactly once per target. Must be pure. */
  facts: (target: T) => CoverageFacts,
): T[] {
  const read = targets.map((target) => ({ target, facts: facts(target) }));
  return read
    .filter(({ facts: f }) => {
      // A system target is never a candidate — this is also what makes self-comparison safe.
      if (f.systemId !== null || f.itemSystemId === null) return true;
      return !read.some(
        ({ facts: other }) =>
          other.systemId !== null &&
          other.systemId === f.itemSystemId &&
          datesAgree(f.dueOn, other.dueOn),
      );
    })
    .map(({ target }) => target);
}
