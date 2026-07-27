# Stop forms failing silently on unplaceable field errors

**Date:** 2026-07-27
**Status:** Approved (design)
**Issue:** [#304](https://github.com/owine/house-manager/issues/304)

## Problem

`applyActionFieldErrors` (`lib/forms/helpers.ts:9-21`) returns `true` whenever it calls `setError` at least once — regardless of whether any form field exists at that path. All ten forms use that boolean to decide whether to show a fallback toast:

```ts
const applied = applyActionFieldErrors(setError, result);
if (result.formError) setError('root', { message: result.formError });
if (!applied && !result.formError) toast.error('Failed to save item');
```

When a key matches no registered field, the message is written into RHF's error tree at a path nothing reads, `applied` is nevertheless `true`, and the fallback toast is suppressed. The user submits the form, the button re-enables, and **nothing happens** — no inline error, no toast, no banner, no save.

### Reproducible on `main` today

1. Create an item in the **`other`** category (or any category with no specific metadata schema — these fall through to `freeformMetadataSchema`).
2. In the Metadata JSON textarea, enter a value that is not a permitted scalar: `{"dims": {"w": 3}}`. `freeformMetadataSchema` (`lib/categories.ts:6-9`) allows `string | number | boolean | null` values only.
3. Save.

Expected: an error explaining the metadata is invalid. Actual: nothing.

Traced end to end:

1. `lib/items/actions.ts:33` builds the key as `['metadata', ...issue.path].join('.')` → `"metadata.dims"`.
2. `applyActionFieldErrors` calls `setError('metadata.dims', …)` and sets `applied = true`.
3. RHF treats the dot as a nested path, producing `errors.metadata = { dims: { message } }` — note there is no `errors.metadata.message`.
4. The freeform UI registers exactly one field, `name="metadata"` (`components/items/ItemMetadataFields.tsx:203-227`). Nothing is registered at `metadata.dims`.
5. `FormMessage` (`components/ui/form.tsx:105-107`) reads `error?.message` for field `metadata`. That is now an object whose own `.message` is `undefined`, so the body is empty and it renders `null`.
6. `ItemForm.tsx:103` is `if (!applied && !result.formError) toast.error(...)`. `applied` is `true`, so no toast. `formError` is unset on this branch, so no banner either.

The root cause is a contract problem in one helper: **"I attached a message somewhere" is not the same claim as "the user can see a message."**

## Goal

A form submission that fails validation always tells the user something, whatever shape the server's `fieldErrors` keys take.

## Non-goals

- Changing how any action validates, or which errors it produces.
- Changing the ten call sites. Their shape is identical and correct; the fix belongs behind them.
- Reworking `FormMessage` or the RHF integration generally.

## Key facts established

- **Exactly one producer emits an unplaceable key.** Every other `fieldErrors` in the codebase comes from `parsed.error.flatten().fieldErrors`, which by definition yields only top-level keys, and every top-level key corresponds to a registered field. The sole exception is the hand-rolled metadata loop in `lib/items/actions.ts:33` and `:89`.
- **Nested field names DO exist in this codebase.** `app/(app)/_components/SuggestionPreview.tsx:44` registers a field array (`useFieldArray({ name: 'proposals' })`) and `components/ai/SuggestionRow.tsx:36` registers `proposals.${index}` via `useController`. That form does not currently call `applyActionFieldErrors` — but the design must not assume dotted keys are always unregistered, because in this codebase they sometimes are registered.
- **All ten call sites are byte-identical in shape**, so a change inside the helper reaches every form with no call-site churn.

## Design

### 1. `applyActionFieldErrors` stops over-claiming

`applied` changes meaning from "I called `setError`" to **"the user will see at least one message."**

A key containing `.` **might or might not** match a registered field — this codebase contains both cases. Rather than guess, the helper does both: it sets the error on the given path (so it renders inline if that path is registered) **and** mirrors the message to the form-level `root` banner, which every form renders.

The worst case becomes a message shown twice rather than a message shown never. Only flat keys — which always render — count toward `applied` on their own.

```ts
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

    // A dotted key may or may not correspond to a registered field: forms in
    // this codebase register both flat names and nested ones (see
    // SuggestionRow's `proposals.${index}`). If it is NOT registered, RHF nests
    // the error under the parent, where FormMessage reads `error.message`,
    // finds an object, and renders nothing — while `applied` would have
    // suppressed the caller's fallback toast. So mirror dotted keys to the
    // form-level banner rather than guessing. Worst case the message appears
    // twice; it never appears zero times.
    if (field.includes('.')) mirrored.push(message);
    else applied = true; // a flat key always has a field to render it
  }

  // Defer to the caller when it will set root itself: every call site does
  // `if (result.formError) setError('root', ...)` immediately after this,
  // which would overwrite us. The user still sees that formError, so this is
  // never silent.
  if (mirrored.length > 0 && !result.formError) {
    setError('root', { type: 'server', message: mirrored.join('; ') });
    applied = true;
  }

  return applied;
}
```

`'root'` is special-cased by RHF's `setError` typing, so it needs no cast — matching all ten existing call sites, which call `setError('root', …)` uncast. The `as Path<T>` on the loop variable is still required, since `field` is an arbitrary string.

Messages are joined with `'; '` rather than a space: server messages are fragments (`"Invalid input"`, `"Required"`), and space-joining several runs them together with no visual break.

Two incidental changes, both tidy-ups rather than behaviour changes: an empty `messages` array is skipped explicitly, and `messages?.[0]` replaces the `messages && messages.length > 0` guard.

`applied` remains `true` when the helper sets `root`, because the user does see something — which is what the flag now means.

**One honest caveat.** When a dotted key arrives *and* `result.formError` is set, the helper returns `applied === false` even though the user will see the caller's `formError` banner. Strictly, that undersells the new definition. It is safe because no call site inspects `applied` alone — the guard is `!applied && !result.formError`, and the `formError` half does the suppressing. The alternative (returning `true` for something the helper did not itself render) would be a worse lie. The tests assert this branch explicitly so a refactor cannot flip it unnoticed.

### 2. `lib/items/actions.ts` stops producing unplaceable keys

Both loops (`:33` and `:89`) build `['metadata', ...issue.path].join('.')`. The freeform metadata UI registers a single `metadata` field, so collapse to that key and move the offending path into the message, so the user still learns which key is at fault:

```ts
const path = issue.path.join('.');
const message = path ? `${path}: ${issue.message}` : issue.message;
(fieldErrors.metadata ??= []).push(message);
```

`{"dims": {"w": 3}}` then yields `metadata: ["dims: Invalid input"]`, rendered by the textarea's own `FormMessage`.

This is the narrower fix and it alone would close the reported bug. §1 is what stops the next producer of a nested path from reintroducing it.

### 3. Why not a "no nested fields" assumption

An earlier draft routed dotted keys to `root` *instead of* their path, justified by "no form registers a nested field name" and pinned by a test scanning `components/**`.

That claim is false — see *Key facts* above — and, worse, the proposed test would not have detected the falsehood: `SuggestionRow`'s name is a template literal passed to `useController`, and the `useFieldArray` call sits in `app/(app)/_components/`, outside the scanned directory. A source-text scan cannot reliably identify dynamic registrations.

Setting both paths removes the need for any such assumption.


## Rejected alternatives

- **Introspect RHF's registered names.** Accurate for any form shape, but `control._names.mount` and `control._fields` are private, underscore-prefixed APIs with no cross-version stability guarantee. This repo tilde-pins to patch, so RHF minors arrive as routine Renovate PRs.
- **Have each caller pass its valid field names.** Fully explicit, but creates ten lists to keep in sync with ten schemas forever. A drifted list fails in exactly the silent way this work exists to eliminate.

## Testing

**`lib/forms/helpers.test.ts`** (new — the file has no tests today):

- A flat key calls `setError` with that field name; `applied` is `true`.
- A dotted key calls `setError` with the dotted name **and** mirrors the message to `root`; `applied` is `true`.
- A dotted key alone (no flat keys) still yields `applied === true` — this is the regression the issue reports.
- A dotted key **with** `result.formError` present sets the dotted path, leaves `root` alone, and returns **`applied === false`** — asserting the return value, not just the `setError` calls, since this is the one branch where the flag's meaning is indirect.
- Mixed flat and dotted keys: the flat one lands on its field, the dotted one lands on both its path and `root`.
- Multiple dotted keys are joined into one `root` message, separated by `'; '`.
- Absent `fieldErrors` returns `false` with no calls.
- An empty `messages` array is skipped and does not make `applied` true.

**The invariant test** described in §3.

**Items action coverage** — `tests/integration/items-metadata-reserved-key.test.ts` does **not** exist on `main` (it was created on an unrelated feature branch). Create a new integration test, following the Testcontainers conventions in `tests/integration/`, asserting that `createItem` given `{"dims": {"w": 3}}` on an `other`-category item returns `fieldErrors` with the key `metadata` and **no** key matching `/^metadata\./`. That is the exact reproduction from the issue, asserted against the real action.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Fix the trigger **and** harden the helper |
| Detection | None — a dotted key is set on its path **and** mirrored to `root`, so no assumption about registration is needed |
| Worst case | A message shown twice, never a message shown zero times |
| `root` ownership | Helper defers when `result.formError` is set |
| `applied` semantics | "The user will see a message", not "setError was called" |
| Call sites | Unchanged — all ten keep their current shape |
