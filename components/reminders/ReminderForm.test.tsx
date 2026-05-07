// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateReminderInput } from '@/lib/reminders/schema';
import type { ActionResult } from '@/lib/result';
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
      expect(screen.getByText(/at least one item or system/i)).toBeInTheDocument();
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
