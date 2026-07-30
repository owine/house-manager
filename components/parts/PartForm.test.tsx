// @vitest-environment jsdom
//
// The metadata-wipe test below is the reason this file exists. Its item-side
// twin (ItemForm.test.tsx, fixed in 5efebda) pins a bug that shipped and hid
// for months: the "reset the spec when the discriminator changes" effect also
// fired on MOUNT, so opening any edit form and saving untouched submitted
// `metadata: {}` and destroyed every stored spec value.
//
// It hid because the shadcn Select keeps its own uncontrolled value — the form
// still looked populated while the payload was empty. So these tests assert on
// the SUBMITTED PAYLOAD, never on rendered inputs. A render-level assertion
// passes against the bug.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreatePartInput } from '@/lib/parts/schema';
import type { ActionResult } from '@/lib/result';
import { PartForm } from './PartForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
});

function makeAction(result: ActionResult<{ id: string }>) {
  return vi.fn<
    (
      input: CreatePartInput | (CreatePartInput & { id: string }),
    ) => Promise<ActionResult<{ id: string }>>
  >(async () => result);
}

describe('PartForm', () => {
  // THE regression test. Remove the `prevKind` ref guard in PartForm and this
  // fails with `metadata: {}` in the submitted payload.
  it('does not wipe the stored spec when an edit form is opened and saved untouched', async () => {
    const action = makeAction({ ok: true, data: { id: 'p1' } });
    const user = userEvent.setup();
    const metadata = { base: 'E26', shape: 'BR30', watts: 9, dimmable: true };

    render(
      <PartForm
        defaultValues={{ id: 'p1', name: 'Kitchen can light', kind: 'BULB', metadata }}
        action={action}
        submitLabel="Save part"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save part' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    expect(action.mock.calls[0]?.[0]).toMatchObject({ metadata });
  });

  it('submits the id on edit and omits it on create', async () => {
    const action = makeAction({ ok: true, data: { id: 'p2' } });
    const user = userEvent.setup();

    render(<PartForm action={action} submitLabel="Create part" />);

    await user.type(screen.getByLabelText(/^Name$/), 'Softener salt');
    await user.click(screen.getByRole('button', { name: 'Create part' }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const payload = action.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.name).toBe('Softener salt');
    expect(payload).not.toHaveProperty('id');
  });

  it('clears the spec when the kind actually changes', async () => {
    const action = makeAction({ ok: true, data: { id: 'p3' } });
    const user = userEvent.setup();

    render(
      <PartForm
        defaultValues={{
          id: 'p3',
          name: 'Kitchen can light',
          kind: 'BULB',
          metadata: { base: 'E26', watts: 9 },
        }}
        action={action}
        submitLabel="Save part"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: /kind/i }));
    await user.click(await screen.findByRole('option', { name: 'Air filter' }));

    await user.click(screen.getByRole('button', { name: 'Save part' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    const payload = action.mock.calls[0]?.[0] as { kind: string; metadata: unknown };
    expect(payload.kind).toBe('AIR_FILTER');
    // A bulb's watts must not travel into an air filter's spec.
    expect(payload.metadata).toEqual({});
  });

  // The same silent-failure plumbing #304 pinned for items: a server-side
  // rejection keyed on `metadata` has to become something the user can SEE.
  // `OTHER` is the kind whose UI registers a single `metadata` field — the one
  // `lib/parts/actions.ts` keys its collapsed spec errors on.
  it('renders a server-side spec validation error to the user', async () => {
    const action = makeAction({
      ok: false,
      fieldErrors: { metadata: ['_notes: is reserved'] },
    });
    const user = userEvent.setup();

    render(
      <PartForm
        defaultValues={{ id: 'p4', name: 'Softener salt', kind: 'OTHER' }}
        action={action}
        submitLabel="Save part"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save part' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    await screen.findByText(/_notes: is reserved/);
  });
});
