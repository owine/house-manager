# Silent Form Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a failed form submission always shows the user something, whatever shape the server's `fieldErrors` keys take.

**Architecture:** `applyActionFieldErrors` sets every field error on its own path *and* mirrors dotted keys to the form-level `root` banner, so no assumption about which paths are registered is needed. Separately, `lib/items/actions.ts` stops emitting dotted metadata keys, which is the one live trigger.

**Tech Stack:** TypeScript, React Hook Form 7.82, Zod, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-07-27-silent-form-failure-design.md` (commit `7a70950`)

**Issue:** [#304](https://github.com/owine/house-manager/issues/304)

**Branch:** `fix/silent-form-failure`

---

## Read this before Task 1

**The bug in one line:** `applied` currently means "I called `setError`", every form reads it as "the user can see a message", and those are different claims. When they diverge the form does nothing at all — no inline error, no toast, no banner, no save.

**Do not "simplify" by diverting dotted keys to `root` instead of setting both.** An earlier draft did exactly that, on the premise that no form registers a nested field name. That premise is false — `components/ai/SuggestionRow.tsx:36` registers `` `proposals.${index}` `` via `useController`, backed by `useFieldArray` in `app/(app)/_components/SuggestionPreview.tsx:44`. Setting both paths is what removes the need for any such assumption.

**Do not change the ten call sites.** They are byte-identical and correct; the fix belongs behind them.

Use `pnpm`, never `npx`/`npm`. Never `git commit --no-verify` — and commits can fail *silently* behind the Biome pre-commit hook, so run `git log --oneline -1` after each and confirm HEAD moved.

---

## File Structure

**Modified:**

| File | Change |
|---|---|
| `lib/forms/helpers.ts` | `applied` means "user will see a message"; dotted keys mirrored to `root` |
| `lib/items/actions.ts` | Two identical metadata-error loops → one shared helper that keys on `metadata` |

**Created:**

| File | Responsibility |
|---|---|
| `lib/forms/helpers.test.ts` | Unit tests for the helper. Pure — `setError` is a spy, no DOM, no database. |
| `tests/integration/items-metadata-errors.test.ts` | The issue's exact reproduction against the real `createItem`. |

---

# Task 1: Harden the helper

Isolated — no call site changes, so this commits on its own.

**Files:**
- Modify: `lib/forms/helpers.ts`
- Create: `lib/forms/helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/forms/helpers.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { applyActionFieldErrors } from './helpers';

// `setError` is the only thing the helper touches, so a spy is the whole
// harness — no form, no DOM, no RHF instance needed.
function spy() {
  return vi.fn();
}

describe('applyActionFieldErrors', () => {
  it('returns false and calls nothing when there are no fieldErrors', () => {
    const setError = spy();
    // biome-ignore lint/suspicious/noExplicitAny: spy stands in for UseFormSetError
    expect(applyActionFieldErrors(setError as any, { ok: false })).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('sets a flat key on its own field and reports applied', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: ['Required'] },
    });

    expect(applied).toBe(true);
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Required' });
    expect(setError).toHaveBeenCalledTimes(1);
  });

  // The regression from #304: a dotted key alone used to return applied=true
  // while rendering nothing, which suppressed the caller's fallback toast.
  it('mirrors a dotted key to root and still reports applied', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { 'metadata.dims': ['Invalid input'] },
    });

    expect(applied).toBe(true);
    expect(setError).toHaveBeenCalledWith('metadata.dims', {
      type: 'server',
      message: 'Invalid input',
    });
    expect(setError).toHaveBeenCalledWith('root', {
      type: 'server',
      message: 'Invalid input',
    });
  });

  it('sets a flat key on its field and a dotted key on both its path and root', () => {
    const setError = spy();
    applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: ['Required'], 'metadata.dims': ['Invalid input'] },
    });

    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Required' });
    expect(setError).toHaveBeenCalledWith('metadata.dims', {
      type: 'server',
      message: 'Invalid input',
    });
    expect(setError).toHaveBeenCalledWith('root', {
      type: 'server',
      message: 'Invalid input',
    });
  });

  it('joins several dotted messages into one root message', () => {
    const setError = spy();
    applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { 'metadata.a': ['First'], 'metadata.b': ['Second'] },
    });

    expect(setError).toHaveBeenCalledWith('root', {
      type: 'server',
      message: 'First; Second',
    });
  });

  // The caller sets root from result.formError immediately after calling us,
  // which would overwrite anything we put there.
  it('leaves root to the caller when formError is present, and returns false', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { 'metadata.dims': ['Invalid input'] },
      formError: 'Something went wrong',
    });

    expect(setError).toHaveBeenCalledWith('metadata.dims', {
      type: 'server',
      message: 'Invalid input',
    });
    expect(setError).not.toHaveBeenCalledWith('root', expect.anything());
    // Asserting the RETURN VALUE, not just the calls: this is the one branch
    // where `applied` is indirect — the user sees the caller's formError
    // banner, not anything this helper rendered.
    expect(applied).toBe(false);
  });

  it('skips a key whose messages array is empty', () => {
    const setError = spy();
    const applied = applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: [] },
    });

    expect(applied).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it('uses only the first message when a key has several', () => {
    const setError = spy();
    applyActionFieldErrors(setError as any, {
      ok: false,
      fieldErrors: { name: ['First', 'Second'] },
    });

    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'First' });
    expect(setError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and verify they FAIL**

```bash
pnpm exec vitest run lib/forms/helpers.test.ts
```

Expected: the dotted-key tests FAIL — today the helper never calls `setError('root', …)`, and the empty-messages test may pass incidentally. At minimum "mirrors a dotted key to root" and "joins several dotted messages" must be red.

- [ ] **Step 3: Rewrite the helper**

Replace the body of `applyActionFieldErrors` in `lib/forms/helpers.ts`, keeping the existing imports:

```ts
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
```

`'root'` needs no cast — RHF's `setError` typing special-cases it, matching all ten call sites. The `as Path<T>` on `field` is still required since it is an arbitrary string.

- [ ] **Step 4: Run and verify they PASS**

```bash
pnpm exec vitest run lib/forms/helpers.test.ts
pnpm typecheck
```

Expected: 8 passing, typecheck clean.

- [ ] **Step 5: Verify the tests are non-vacuous**

Temporarily delete the `if (mirrored.length > 0 && !result.formError)` block. Confirm "mirrors a dotted key to root" and "joins several dotted messages" go RED. Then restore and re-run.

Report what you saw. A test that passes for the wrong reason is worse than no test — this step is not optional.

- [ ] **Step 6: Commit**

```bash
git add lib/forms/helpers.ts lib/forms/helpers.test.ts
git commit -m "fix(forms): report applied only when the user will see a message"
git log --oneline -1
```

---

# Task 2: Stop items producing dotted metadata keys

**Files:**
- Modify: `lib/items/actions.ts` (two identical loops, around `:31-37` and `:87-93`)
- Create: `tests/integration/items-metadata-errors.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/items-metadata-errors.test.ts`. Model the setup on `tests/integration/item-archive-restore.test.ts:1-28` — same mocks, same `setupIntegration` / dynamic-import pattern.

The test must assert **both halves**:

```ts
// A nested value is invalid: freeformMetadataSchema allows scalars only.
const result = await actions.createItem({
  name: 'Probe',
  categorySlug: 'other',
  metadata: { dims: { w: 3 } },
});

expect(result.ok).toBe(false);
if (result.ok) return;

// The key must be the registered field name...
expect(Object.keys(result.fieldErrors ?? {})).toContain('metadata');
// ...and NOT a nested path. This is the assertion that pins the fix:
// `metadata.dims` is what made the form fail silently.
expect(Object.keys(result.fieldErrors ?? {}).filter((k) => k.startsWith('metadata.'))).toEqual([]);
// The offending path moves into the message so the user still knows which key.
expect(result.fieldErrors?.metadata?.[0]).toMatch(/dims/);
```

Any slug not in `categoryConfigs` falls through to `freeformMetadataSchema`, so an unknown slug works.

**Note the order of operations**: in `createItem`, metadata validation runs *before* the category DB lookup, so this path returns without ever querying the category table — the row does not need to exist for this case. Create it anyway, because Step 5 does need it.

- [ ] **Step 2: Run and verify it FAILS**

```bash
docker compose up -d db meilisearch
pnpm exec vitest run tests/integration/items-metadata-errors.test.ts
```

Expected: FAIL — the key is currently `metadata.dims`, so `toContain('metadata')` fails and the `startsWith` filter is non-empty.

- [ ] **Step 3: Extract the shared loop and fix the key**

Both sites are byte-identical, so extract one file-local helper rather than editing the same six lines twice. Add near the top of `lib/items/actions.ts`, after the imports:

```ts
/**
 * Collapse a metadata validation failure onto the `metadata` field.
 *
 * The freeform metadata UI registers a single `metadata` textarea, so a nested
 * key like `metadata.dims` matches no field: RHF would nest the error where
 * FormMessage cannot read it and the form would fail silently (issue #304).
 * The offending path moves into the message instead, so the user still learns
 * which key is at fault.
 */
function metadataFieldErrors(issues: z.core.$ZodIssue[]): Record<string, string[]> {
  const messages = issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { metadata: messages };
}
```

> Match the issue type to whatever this file's Zod version exposes — check the existing `metadataResult.error.issues` type rather than assuming. If importing a Zod type adds noise, typing the parameter as `{ path: PropertyKey[]; message: string }[]` is acceptable and keeps the helper dependency-free.

Then replace both loops with:

```ts
    if (!metadataResult.success) {
      return { ok: false, fieldErrors: metadataFieldErrors(metadataResult.error.issues) };
    }
```

- [ ] **Step 4: Run and verify it PASSES**

```bash
pnpm exec vitest run tests/integration/items-metadata-errors.test.ts
pnpm typecheck
```

- [ ] **Step 5: Confirm the second site is covered too**

The test above only exercises `createItem`, but the fix changes two sites. Add a second case calling `updateItem` with the same invalid metadata and the same two assertions — without it, the `updateItem` site could regress unnoticed.

**Seeding for this case needs care.** You cannot create the item by calling `createItem` with the bad metadata — it would be rejected before an item exists. Either:

- create the row directly with `ctx.prisma.item.create({ data: { name, categoryId } })`, as `tests/integration/item-archive-restore.test.ts` does, then call `actions.updateItem({ id, metadata: { dims: { w: 3 } } })`; or
- call `createItem` once with *valid* metadata, then `updateItem` with the invalid payload.

The first is simpler and matches the precedent file.

`updateItem` accepts the same shape — `updateItemSchema = createItemSchema.partial().extend({ id })`.

- [ ] **Step 6: Commit**

```bash
git add lib/items/actions.ts tests/integration/items-metadata-errors.test.ts
git commit -m "fix(items): key metadata validation errors on the registered field"
git log --oneline -1
```

---

# Task 3: Verification and PR

- [ ] **Step 1: Full local gate**

```bash
DATABASE_URL="postgresql://knip:knip@localhost:5432/knip" pnpm verify
pnpm test:integration
```

Both must pass. `pnpm lint` needs `DATABASE_URL` for knip; the pre-push hook supplies its own dummy.

- [ ] **Step 2: Manually confirm the reported bug is gone**

The issue is a UI bug, and no automated test in this plan renders the actual form. Verify by hand:

```bash
docker compose up -d db meilisearch
pnpm dev
```

Create an item in the **`other`** category, put `{"dims": {"w": 3}}` in the Metadata textarea, and save. Before this change: nothing happens. After: an inline error under the textarea naming `dims`.

Report what you saw. If nothing renders, **stop** — the fix has not achieved its purpose and the remaining gap needs diagnosing, not papering over.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/silent-form-failure
gh pr create --fill
```

Reference `Closes #304` in the body.

Then per this repo's workflow: watch **strictly** the "Sourcery review" check; if it runs, address its comments first. Then `gh pr merge --auto --squash`, then `gh pr checks --watch --fail-fast`. Run both watches in the background.

**Push from a checkout of this branch** — the pre-push hook lints the working tree, not the ref being pushed.

---

## Deferred — do not build

- Changing any of the ten call sites. Their shape is correct.
- A test scanning the codebase for nested field registrations. The design deliberately needs no such invariant; adding the test would imply one exists.
- Reworking `FormMessage` or the wider RHF integration.
