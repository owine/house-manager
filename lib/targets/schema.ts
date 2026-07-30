import { z } from 'zod';

/**
 * Item-XOR-System target. **Keep this narrow — do not add `partId`.**
 *
 * Two consumers depend on exactly-one-of-two, and their tables kept the
 * two-column XOR CHECK constraint:
 *   - `lib/warranties/schema.ts` (via `targetsArraySchema`) → `warranty_targets`
 *   - `lib/incoming-email/actions.ts` → `incoming_email_targets`
 *
 * Neither table has a `partId` column. If this refine were widened to
 * exactly-one-of-three, a `{ partId }` payload would pass Zod for a warranty,
 * its mapper would write a row with item/system both NULL, and
 * `warranty_targets_parent_xor` would reject it at the database — a 500 instead
 * of a form error. Reminders and service records use `partTargetSchema` below.
 */
export const targetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
  })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.systemId), {
    message: 'exactly one of itemId / systemId must be set',
  });

export const targetsArraySchema = z.array(targetSchema).min(1);

export type TargetInput = z.infer<typeof targetSchema>;

/**
 * Item-XOR-System-XOR-Part target, for reminders and service records — the two
 * tables whose CHECK constraints now count three columns.
 *
 * Cardinality is NOT expressed here: a CHORE may submit an empty targets array
 * (lib/reminders/schema.ts uses z.array(...) with no .min), and the standalone
 * both-NULL row is minted by reconciliation, never submitted.
 */
export const partTargetSchema = z
  .object({
    itemId: z.string().min(1).optional().nullable(),
    systemId: z.string().min(1).optional().nullable(),
    partId: z.string().min(1).optional().nullable(),
  })
  .refine((t) => [t.itemId, t.systemId, t.partId].filter(Boolean).length === 1, {
    message: 'exactly one of itemId / systemId / partId must be set',
  });

export type PartTargetInput = z.infer<typeof partTargetSchema>;

/**
 * Convert persisted target rows into form `PartTargetInput`s for editing.
 *
 * The predicate spans all three parent columns: a row linked only to a part
 * must survive, or the edit form submits without it and `updateReminder`'s diff
 * deletes it.
 *
 * Standalone chore targets carry none of the three parents. They must be
 * dropped here (not mapped to `{ systemId: null }`) so the edit form submits an
 * empty targets list — `updateReminder` then reconciles a CHORE with no links
 * back to the standalone shape. Emitting an all-null row instead would fail
 * `partTargetSchema`'s XOR refine and block every save of a standalone chore.
 */
export function toTargetInputs(
  rows: { itemId: string | null; systemId: string | null; partId: string | null }[],
): PartTargetInput[] {
  return rows
    .filter((t) => t.itemId !== null || t.systemId !== null || t.partId !== null)
    .map((t) => {
      if (t.itemId !== null) return { itemId: t.itemId };
      if (t.systemId !== null) return { systemId: t.systemId };
      return { partId: t.partId as string };
    });
}
