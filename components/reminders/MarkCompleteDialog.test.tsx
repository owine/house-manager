// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@/lib/result';
import { expectNoAxeViolations } from '@/tests/a11y/axe';
import {
  type CompleteReminderAction,
  MarkCompleteDialog,
  type ReminderTargetSummary,
} from './MarkCompleteDialog';

afterEach(() => {
  cleanup();
});

const targets: ReminderTargetSummary[] = [
  { id: 't1', label: 'Furnace', kind: 'item' },
  { id: 't2', label: 'AC condenser', kind: 'item' },
  { id: 't3', label: 'HVAC', kind: 'system' },
];

function makeAction(result: ActionResult<{ id: string }> = { ok: true, data: { id: 'r1' } }) {
  return vi.fn<CompleteReminderAction>(async () => result);
}

function setup(overrides: Partial<React.ComponentProps<typeof MarkCompleteDialog>> = {}) {
  const action = overrides.action ?? makeAction();
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const onCompleted = overrides.onCompleted ?? vi.fn();
  const utils = render(
    <MarkCompleteDialog
      reminderId="r1"
      reminderTitle="Replace filter"
      targets={targets}
      open
      onOpenChange={onOpenChange}
      onCompleted={onCompleted}
      action={action}
      {...overrides}
    />,
  );
  return { action, onOpenChange, onCompleted, ...utils };
}

describe('MarkCompleteDialog', () => {
  it('renders the title and all target rows pre-checked', () => {
    setup();
    expect(screen.getByText('Mark complete: Replace filter')).toBeInTheDocument();
    const list = screen.getByTestId('mark-complete-targets-list');
    for (const t of targets) {
      const cb = within(list).getByRole('checkbox', { name: new RegExp(t.label) });
      expect(cb).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('unchecking a target reduces the count submitted', async () => {
    const user = userEvent.setup();
    const { action } = setup();
    const list = screen.getByTestId('mark-complete-targets-list');
    await user.click(within(list).getByRole('checkbox', { name: /AC condenser/ }));

    await user.click(screen.getByRole('button', { name: /Save completion/ }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith({
      id: 'r1',
      targetIds: ['t1', 't3'],
      notes: '',
    });
  });

  it('submit with all targets unchecked shows the inline error and does not call the action', async () => {
    const user = userEvent.setup();
    const { action } = setup();
    const list = screen.getByTestId('mark-complete-targets-list');
    for (const t of targets) {
      await user.click(within(list).getByRole('checkbox', { name: new RegExp(t.label) }));
    }
    await user.click(screen.getByRole('button', { name: /Save completion/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one target');
    expect(action).not.toHaveBeenCalled();
  });

  it('submit calls completeReminder with the right shape and fires callbacks', async () => {
    const user = userEvent.setup();
    const { action, onOpenChange, onCompleted } = setup();

    await user.type(screen.getByLabelText(/Notes/), 'changed filter, all good');
    await user.click(screen.getByRole('button', { name: /Save completion/ }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith({
      id: 'r1',
      targetIds: ['t1', 't2', 't3'],
      notes: 'changed filter, all good',
    });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows formError from the action result inline', async () => {
    const user = userEvent.setup();
    const action = makeAction({ ok: false, formError: 'Boom' });
    setup({ action });
    await user.click(screen.getByRole('button', { name: /Save completion/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Boom'));
  });

  it('has no axe violations', async () => {
    setup();
    await expectNoAxeViolations();
  });

  it('Cancel closes without calling the action', async () => {
    const user = userEvent.setup();
    const { action, onOpenChange } = setup();
    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(action).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
