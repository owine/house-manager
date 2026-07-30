// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateReminderInput } from '@/lib/reminders/schema';
import type { ActionResult } from '@/lib/result';
import { expectNoAxeViolations } from '@/tests/a11y/axe';
import { ReminderForm } from './ReminderForm';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  pushMock.mockClear();
});

function makeAction(result: ActionResult<{ id: string }>) {
  return vi.fn<
    (
      input: CreateReminderInput | (CreateReminderInput & { id: string }),
    ) => Promise<ActionResult<{ id: string }>>
  >(async () => result);
}

const availableItems = [{ id: 'i1', name: 'Furnace', categoryName: 'HVAC', archivedAt: null }];
const availableSystems = [
  {
    id: 's1',
    name: 'HVAC',
    kind: 'hvac',
    items: [] as Array<{ id: string; archivedAt: Date | null }>,
  },
];

const availableParts = [
  { id: 'p1', name: '20x25x1 furnace filter', kind: 'AIR_FILTER', archivedAt: null },
];

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Title$/), 'Replace filter');
  await user.type(screen.getByLabelText(/^First due date$/), '2026-02-01');
}

describe('ReminderForm with TargetsPicker', () => {
  it('renders empty picker when no initialTargets', () => {
    const action = makeAction({ ok: true, data: { id: 'r-1' } });
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    expect(screen.queryByTestId('targets-picker-chips')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const action = makeAction({ ok: true, data: { id: 'r-1' } });
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    await expectNoAxeViolations();
  });

  it('pre-seeds picker from initialTargets', () => {
    const action = makeAction({ ok: true, data: { id: 'r-1' } });
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={[{ itemId: 'i1' }]}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    expect(screen.getByTestId('targets-picker-chips')).toHaveTextContent('Furnace');
  });

  it('blocks submit and shows the at-least-one-target error', async () => {
    const action = makeAction({ ok: true, data: { id: 'r-1' } });
    const user = userEvent.setup();
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create reminder' }));
    await waitFor(() => {
      expect(screen.getByText(/at least one item, system, or part/i)).toBeInTheDocument();
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('submits with targets: [{ itemId }] for a single item-target reminder', async () => {
    const action = makeAction({ ok: true, data: { id: 'r-new' } });
    const user = userEvent.setup();
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={[{ itemId: 'i1' }]}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create reminder' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({
      title: 'Replace filter',
      targets: [{ itemId: 'i1' }],
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/reminders/r-new'));
  });

  it('allows chore submission with zero targets and shows optional label', async () => {
    const action = makeAction({ ok: true, data: { id: 'c-new' } });
    const user = userEvent.setup();
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Create chore"
        kind="CHORE"
      />,
    );
    // Label reads as optional for chores.
    expect(screen.getByText(/Linked items \/ systems \/ parts \(optional\)/i)).toBeInTheDocument();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create chore' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({
      title: 'Replace filter',
      kind: 'CHORE',
      targets: [],
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/reminders/c-new'));
    expect(screen.queryByText(/at least one item, system, or part/i)).not.toBeInTheDocument();
  });

  it('shows the autoComplete checkbox only when kind=CHORE', () => {
    const action = makeAction({ ok: true, data: { id: 'r-1' } });
    const { rerender } = render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Create chore"
        kind="CHORE"
      />,
    );
    expect(screen.getByRole('checkbox', { name: /auto-complete/i })).toBeInTheDocument();

    rerender(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Create reminder"
        kind="REMINDER"
      />,
    );
    expect(screen.queryByRole('checkbox', { name: /auto-complete/i })).not.toBeInTheDocument();
  });

  // Regression guard for the silent-delete path: an edit form seeded with a
  // part target and submitted UNTOUCHED must resubmit that target. If the
  // picker dropped it, updateReminder's diff would see it in `have` but not
  // `want` and delete the row. Asserts on the SUBMITTED PAYLOAD, not on chips.
  it('resubmits a seeded part target when the form is saved untouched', async () => {
    const action = makeAction({ ok: true, data: { id: 'r-1' } });
    const user = userEvent.setup();
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        availableParts={availableParts}
        initialTargets={[{ partId: 'p1' }]}
        defaultValues={{ id: 'r-1', title: 'Swap filter', nextDueOn: new Date('2026-02-01') }}
        action={action}
        submitLabel="Save changes"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({ targets: [{ partId: 'p1' }] });
  });

  it('offers parts in the picker and submits a newly-checked part target', async () => {
    const action = makeAction({ ok: true, data: { id: 'r-new' } });
    const user = userEvent.setup();
    render(
      <ReminderForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        availableParts={availableParts}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /^Parts/ }));
    await user.click(
      within(screen.getByTestId('targets-picker-parts-list')).getByRole('checkbox', {
        name: /20x25x1 furnace filter/,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Create reminder' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({ targets: [{ partId: 'p1' }] });
  });

  it('submits with targets: [{ systemId }] for a system-only reminder', async () => {
    const action = makeAction({ ok: true, data: { id: 'r-new' } });
    const user = userEvent.setup();
    render(
      <ReminderForm
        availableItems={[]}
        availableSystems={availableSystems}
        initialTargets={[{ systemId: 's1' }]}
        action={action}
        submitLabel="Create reminder"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create reminder' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({ targets: [{ systemId: 's1' }] });
  });
});
