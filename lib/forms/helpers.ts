import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import type { ActionResult } from '@/lib/result';

/**
 * Map an ActionResult's fieldErrors into RHF's setError, so server-side
 * validation errors appear under the same FormMessage components as
 * client-side Zod errors. Returns true if errors were applied.
 */
export function applyActionFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  result: Extract<ActionResult<unknown>, { ok: false }>,
): boolean {
  if (!result.fieldErrors) return false;
  let applied = false;
  for (const [field, messages] of Object.entries(result.fieldErrors)) {
    if (messages && messages.length > 0) {
      setError(field as Path<T>, { type: 'server', message: messages[0] });
      applied = true;
    }
  }
  return applied;
}
