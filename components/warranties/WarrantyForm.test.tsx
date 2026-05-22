// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/result';
import type { CreateWarrantyInput } from '@/lib/warranties/schema';
import { expectNoAxeViolations } from '@/tests/a11y/axe';
import { WarrantyForm } from './WarrantyForm';

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
      input: CreateWarrantyInput | (CreateWarrantyInput & { id: string }),
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
  await user.type(screen.getByLabelText(/^Provider$/), 'AcmeCo');
  await user.type(screen.getByLabelText(/^Starts on$/), '2026-01-01');
  await user.type(screen.getByLabelText(/^Ends on$/), '2027-01-01');
}

describe('WarrantyForm with TargetsPicker', () => {
  it('renders empty picker when no initialTargets', () => {
    const action = makeAction({ ok: true, data: { id: 'w-1' } });
    render(
      <WarrantyForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Add warranty"
      />,
    );
    expect(screen.queryByTestId('targets-picker-chips')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const action = makeAction({ ok: true, data: { id: 'w-1' } });
    render(
      <WarrantyForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Add warranty"
      />,
    );
    await expectNoAxeViolations();
  });

  it('pre-seeds picker from initialTargets', () => {
    const action = makeAction({ ok: true, data: { id: 'w-1' } });
    render(
      <WarrantyForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={[{ itemId: 'i1' }]}
        action={action}
        submitLabel="Add warranty"
      />,
    );
    expect(screen.getByTestId('targets-picker-chips')).toHaveTextContent('Furnace');
  });

  it('shows error and skips action when no targets', async () => {
    const action = makeAction({ ok: true, data: { id: 'w-1' } });
    const user = userEvent.setup();
    render(
      <WarrantyForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        action={action}
        submitLabel="Add warranty"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add warranty' }));
    await waitFor(() => {
      expect(screen.getByText(/at least one item or system/i)).toBeInTheDocument();
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('submits targets [{ itemId }] for an item-only selection', async () => {
    const action = makeAction({ ok: true, data: { id: 'w-new' } });
    const user = userEvent.setup();
    render(
      <WarrantyForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        initialTargets={[{ itemId: 'i1' }]}
        successRedirect="/items/i1?tab=warranties"
        action={action}
        submitLabel="Add warranty"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add warranty' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({
      targets: [{ itemId: 'i1' }],
      provider: 'AcmeCo',
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/items/i1?tab=warranties'));
  });

  it('submits targets [{ systemId }] when only a system is selected', async () => {
    const action = makeAction({ ok: true, data: { id: 'w-new' } });
    const user = userEvent.setup();
    render(
      <WarrantyForm
        availableItems={[]}
        availableSystems={availableSystems}
        initialTargets={[{ systemId: 's1' }]}
        action={action}
        submitLabel="Add warranty"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Add warranty' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({ targets: [{ systemId: 's1' }] });
  });
});
