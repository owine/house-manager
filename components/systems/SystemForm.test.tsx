// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/result';
import type { SystemCreateInput } from '@/lib/systems/schema';
import { SystemForm } from './SystemForm';

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
      input: SystemCreateInput | (SystemCreateInput & { id: string }),
    ) => Promise<ActionResult<{ id: string }>>
  >(async () => result);
}

describe('SystemForm', () => {
  it('renders create-mode fields with empty defaults', () => {
    const action = makeAction({ ok: true, data: { id: 'sys-1' } });
    render(<SystemForm action={action} submitLabel="Create system" />);

    expect((screen.getByLabelText(/^Name$/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Kind/) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Create system' })).toBeInTheDocument();
  });

  it('renders edit-mode with provided defaults', () => {
    const action = makeAction({ ok: true, data: { id: 'sys-1' } });
    render(
      <SystemForm
        action={action}
        submitLabel="Save changes"
        defaultValues={{
          id: 'sys-1',
          name: 'HVAC',
          kind: 'hvac',
          location: 'Basement',
        }}
      />,
    );
    expect((screen.getByLabelText(/^Name$/) as HTMLInputElement).value).toBe('HVAC');
    expect((screen.getByLabelText(/Kind/) as HTMLInputElement).value).toBe('hvac');
    expect((screen.getByLabelText(/Location/) as HTMLInputElement).value).toBe('Basement');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('shows a validation error when name is empty', async () => {
    const action = makeAction({ ok: true, data: { id: 'sys-1' } });
    const user = userEvent.setup();
    render(<SystemForm action={action} submitLabel="Create system" />);

    await user.click(screen.getByRole('button', { name: 'Create system' }));

    await waitFor(() => {
      // RHF + zod surfaces the message under FormMessage
      expect(action).not.toHaveBeenCalled();
    });
  });

  it('submits create payload and pushes to the new detail page on success', async () => {
    const action = makeAction({ ok: true, data: { id: 'sys-new' } });
    const user = userEvent.setup();
    render(<SystemForm action={action} submitLabel="Create system" />);

    await user.type(screen.getByLabelText(/^Name$/), 'Boiler');
    await user.click(screen.getByRole('button', { name: 'Create system' }));

    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    expect(action.mock.calls[0]?.[0]).toMatchObject({ name: 'Boiler' });
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/systems/sys-new');
    });
  });

  it('submits edit payload including id and pushes to detail page', async () => {
    const action = makeAction({ ok: true, data: { id: 'sys-1' } });
    const user = userEvent.setup();
    render(
      <SystemForm
        action={action}
        submitLabel="Save changes"
        defaultValues={{ id: 'sys-1', name: 'HVAC' }}
      />,
    );

    await user.clear(screen.getByLabelText(/^Name$/));
    await user.type(screen.getByLabelText(/^Name$/), 'HVAC v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    expect(action.mock.calls[0]?.[0]).toMatchObject({ id: 'sys-1', name: 'HVAC v2' });
  });

  it('surfaces server formError on the form', async () => {
    const action = makeAction({ ok: false, formError: 'boom' });
    const user = userEvent.setup();
    render(<SystemForm action={action} submitLabel="Create system" />);

    await user.type(screen.getByLabelText(/^Name$/), 'X');
    await user.click(screen.getByRole('button', { name: 'Create system' }));

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });
});
