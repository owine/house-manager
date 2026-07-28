// @vitest-environment jsdom
//
// Issue #304: a form could fail validation and render NOTHING to the user —
// no inline error, no toast, no banner. Two commits fixed the plumbing:
//   - lib/forms/helpers.ts: applyActionFieldErrors only reports `applied`
//     when the message will actually be visible, and mirrors dotted keys
//     to the root banner.
//   - lib/items/actions.ts: metadata validation errors are now keyed on the
//     registered `metadata` field instead of the unregistered `metadata.dims`.
// lib/forms/helpers.test.ts covers the first fix in isolation, and
// tests/integration covers the action's output shape. Neither proves the
// two actually connect: that FormMessage renders the string to the screen.
// That link is the entire subject of #304, so it gets its own tests here.
// Do not delete these as "redundant" with the unit tests above — they are the
// only tests that would have caught #304 itself.
import type { Category } from '@prisma/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { metadataSchemaFor } from '@/lib/categories';
import type { CreateItemInput } from '@/lib/items/schema';
import type { ActionResult } from '@/lib/result';
import { ItemForm } from './ItemForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
});

// `other` maps to the freeform metadata schema (lib/categories.ts), whose
// UI registers a single `metadata` textarea field — the field the fix in
// lib/items/actions.ts now keys errors on.
const categories: Category[] = [
  { id: 'c1', slug: 'other', name: 'Other', icon: null, sortOrder: 0 },
];

function makeAction(result: ActionResult<{ id: string }>) {
  return vi.fn<
    (
      input: CreateItemInput | (CreateItemInput & { id: string }),
    ) => Promise<ActionResult<{ id: string }>>
  >(async () => result);
}

/**
 * Build the rejection the server would really return for a reserved
 * `_`-prefixed metadata key.
 *
 * The `issue.path` half is genuine: it runs the REAL freeformMetadataSchema
 * via `metadataSchemaFor`, so it tracks whatever that rule actually does — it
 * fails against the old per-key `path: [key]` behaviour and passes once the
 * schema emits a single root-level issue.
 *
 * The key/message shaping is a hand-copied DUPLICATE of `metadataFieldErrors`
 * in lib/items/actions.ts, not a call into it (that helper is file-local). So
 * a regression there — dropping the `metadata` key, or reintroducing a dotted
 * one — would NOT be caught here. Two integration tests cover that seam by
 * calling the real actions end to end:
 * `items-metadata-errors.test.ts` (the key is never dotted) and
 * `items-metadata-reserved-key.test.ts` (the reserved-key rejection).
 */
function makeReservedKeyRejection(): ActionResult<{ id: string }> {
  const result = metadataSchemaFor('other').safeParse({ _notes: 'x' });
  if (result.success) throw new Error('expected freeformMetadataSchema to reject _notes');

  const messages = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, fieldErrors: { metadata: messages } };
}

describe('ItemForm silent-failure regression (#304)', () => {
  it('renders a metadata validation error to the user, not just to the console', async () => {
    const action = makeAction({
      ok: false,
      fieldErrors: { metadata: ['dims: Invalid input'] },
    });
    const user = userEvent.setup();

    render(<ItemForm categories={categories} action={action} submitLabel="Create item" />);

    await user.type(screen.getByLabelText(/^Name$/), 'Garage door');
    await user.click(screen.getByRole('combobox', { name: /category/i }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));

    await user.click(screen.getByRole('button', { name: 'Create item' }));

    await screen.findByText(/dims: Invalid input/);
  });

  it('surfaces the server-side reserved-key rejection on the metadata field', async () => {
    const action = makeAction(makeReservedKeyRejection());
    const user = userEvent.setup();

    render(
      <ItemForm
        categories={categories}
        defaultValues={{ name: 'Kitchen Pendant', categorySlug: 'other' }}
        action={action}
        submitLabel="Save item"
      />,
    );

    const textarea = screen.getByLabelText(/Metadata \(JSON\)/);
    fireEvent.change(textarea, { target: { value: '{"_notes": "x"}' } });

    await user.click(screen.getByRole('button', { name: 'Save item' }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    // The whole point: the rejection must be VISIBLE to the user, not merely
    // returned by the action and dropped on the floor.
    await waitFor(() => {
      expect(screen.getByText(/is reserved/i)).toBeInTheDocument();
    });
  });
});
