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
// That link is the entire subject of #304, so it gets its own test here.
// Do not delete this as "redundant" with the unit tests above — it is the
// only test that would have caught #304 itself.
import type { Category } from '@prisma/client';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, vi } from 'vitest';

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
});
