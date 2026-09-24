// @vitest-environment jsdom
//
// Q-H5: the delete button used to delete on the FIRST click, and a system whose
// only link to a reminder/warranty/service record went with it silently
// orphaned them. These tests pin the confirm step and the blocking list.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemDependentSummary } from '@/lib/systems/actions';
import { expectNoAxeViolations } from '@/tests/a11y/axe';
import { DeleteSystemButton } from './DeleteSystemButton';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

type Props = ComponentProps<typeof DeleteSystemButton>;
type TryDelete = Props['onTryDelete'];

function renderButton(onTryDelete: TryDelete) {
  const onDeleteWithParts = vi.fn<Props['onDeleteWithParts']>(async () => ({
    ok: true,
    archivedCount: 0,
    keptCount: 0,
  }));
  render(
    <DeleteSystemButton
      systemName="Water heater"
      onTryDelete={onTryDelete}
      onDeleteWithParts={onDeleteWithParts}
    />,
  );
}

const DEPENDENTS: SystemDependentSummary[] = [
  { kind: 'reminder', id: 'r1', label: 'Flush water heater' },
  { kind: 'warranty', id: 'w1', label: 'Rheem limited warranty' },
  { kind: 'serviceRecord', id: 's1', label: 'Anode rod swap' },
];

describe('DeleteSystemButton', () => {
  it('asks before deleting: the trigger alone never deletes', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({ ok: true }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));

    expect(await screen.findByText('Permanently delete Water heater?')).toBeInTheDocument();
    expect(onTryDelete).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('delete-system-alert-confirm'));

    await waitFor(() => expect(onTryDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/systems'));
  });

  it('Cancel does not delete', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({ ok: true }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(onTryDelete).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('lists the records that would be orphaned, links each, and offers no delete', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({
      ok: false,
      hasDependents: true,
      dependents: DEPENDENTS,
    }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));
    await user.click(await screen.findByTestId('delete-system-alert-confirm'));

    const reminder = await screen.findByRole('link', { name: 'Flush water heater' });
    expect(reminder).toHaveAttribute('href', '/reminders/r1');
    expect(screen.getByRole('link', { name: 'Rheem limited warranty' })).toHaveAttribute(
      'href',
      '/warranties/w1',
    );
    expect(screen.getByRole('link', { name: 'Anode rod swap' })).toHaveAttribute(
      'href',
      '/service/s1',
    );
    expect(screen.queryByTestId('delete-system-alert-confirm')).toBeNull();
    expect(push).not.toHaveBeenCalled();

    await expectNoAxeViolations();
  });

  it('hands over to the parts prompt when the system has parts', async () => {
    const onTryDelete = vi.fn<TryDelete>(async () => ({
      ok: false,
      hasParts: true,
      parts: [{ id: 'p1', name: 'Anode rod', kind: 'OTHER', willBeOrphaned: true }],
    }));
    renderButton(onTryDelete);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('system-delete-trigger'));
    await user.click(await screen.findByTestId('delete-system-alert-confirm'));

    expect(await screen.findByTestId('delete-system-confirm')).toBeInTheDocument();
  });
});
