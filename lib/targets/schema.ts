import { z } from 'zod';

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
 * Convert persisted target rows into form `TargetInput`s for editing.
 *
 * Standalone chore targets carry neither an itemId nor a systemId. They must be
 * dropped here (not mapped to `{ systemId: null }`) so the edit form submits an
 * empty targets list — `updateReminder` then reconciles a CHORE with no links
 * back to the standalone shape. Emitting a both-null row instead would fail
 * `targetSchema`'s XOR refine and block every save of a standalone chore.
 */
export function toTargetInputs(
  rows: { itemId: string | null; systemId: string | null }[],
): TargetInput[] {
  return rows
    .filter((t) => t.itemId || t.systemId)
    .map((t) => (t.itemId ? { itemId: t.itemId } : { systemId: t.systemId as string }));
}
