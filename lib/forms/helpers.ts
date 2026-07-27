import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import type { ActionResult } from '@/lib/result';

/**
 * Map an ActionResult's fieldErrors into RHF's setError, so server-side
 * validation errors appear under the same FormMessage components as
 * client-side Zod errors.
 *
 * Returns true when THIS CALL rendered something. That distinction is the
 * point: callers use the return value to decide whether to show a fallback
 * toast, and the previous "did I call setError at least once" meaning let a
 * form fail completely silently (issue #304). Note a `false` return with
 * `result.formError` set still means the user sees a message — the caller's
 * banner, not one rendered by this helper.
 */
export function applyActionFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  result: Extract<ActionResult<unknown>, { ok: false }>,
): boolean {
  if (!result.fieldErrors) return false;

  const rootMessages: string[] = [];
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
    if (field.includes('.')) {
      rootMessages.push(message);
    } else {
      // A flat key normally has a field to render it. "Normally" is doing
      // real work: a field rendered inside a conditional block
      // (WarrantyForm's expiryReminderLeadDays, for one) can be unmounted
      // when its error arrives, in which case nothing shows and this
      // `applied` is optimistic. Mirroring every key to root would close
      // that, at the cost of echoing every ordinary validation message into
      // the form banner — not worth it for a case with no known trigger.
      // Dotted keys, which have a live trigger, are mirrored below.
      applied = true;
    }
  }

  // Defer to the caller when it will set root itself: every call site does
  // `if (result.formError) setError('root', ...)` immediately after this and
  // would overwrite us. The user still sees that formError, so never silent.
  if (rootMessages.length > 0 && !result.formError) {
    setError('root', { type: 'server', message: rootMessages.join('; ') });
    applied = true;
  }

  return applied;
}
