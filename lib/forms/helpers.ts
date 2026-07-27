import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import type { ActionResult } from '@/lib/result';

/**
 * Map an ActionResult's fieldErrors into RHF's setError, so server-side
 * validation errors appear under the same FormMessage components as
 * client-side Zod errors.
 *
 * Returns true when the user will actually SEE a message. That distinction is
 * the point: callers use the return value to decide whether to show a fallback
 * toast, and the previous "did I call setError at least once" meaning let a
 * form fail completely silently (issue #304).
 */
export function applyActionFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  result: Extract<ActionResult<unknown>, { ok: false }>,
): boolean {
  if (!result.fieldErrors) return false;

  const mirrored: string[] = [];
  let applied = false;

  for (const [field, messages] of Object.entries(result.fieldErrors)) {
    const message = messages?.[0];
    if (!message) continue;

    setError(field as Path<T>, { type: 'server', message });

    // A dotted key may or may not correspond to a registered field — this
    // codebase has both (SuggestionRow registers `proposals.${index}`). If it
    // is NOT registered, RHF nests the error under the parent, where
    // FormMessage reads `error.message`, finds an object, and renders nothing.
    // So mirror dotted keys to the form-level banner rather than guessing.
    // Worst case the message appears twice; it never appears zero times.
    if (field.includes('.')) mirrored.push(message);
    else applied = true; // a flat key always has a field to render it
  }

  // Defer to the caller when it will set root itself: every call site does
  // `if (result.formError) setError('root', ...)` immediately after this and
  // would overwrite us. The user still sees that formError, so never silent.
  if (mirrored.length > 0 && !result.formError) {
    setError('root', { type: 'server', message: mirrored.join('; ') });
    applied = true;
  }

  return applied;
}
