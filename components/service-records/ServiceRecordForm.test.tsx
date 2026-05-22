// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/result';
import type { CreateServiceRecordInput } from '@/lib/service-records/schema';
import { ServiceRecordForm } from './ServiceRecordForm';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/attachments/actions', () => ({
  uploadAttachment: vi.fn(async () => ({ ok: true, data: { id: 'att1' } })),
  addAttachmentLink: vi.fn(async () => ({ ok: true, data: { id: 'att1' } })),
}));

afterEach(() => {
  cleanup();
  pushMock.mockClear();
});

function makeAction(result: ActionResult<{ id: string }>) {
  return vi.fn<
    (
      input: CreateServiceRecordInput | (CreateServiceRecordInput & { id: string }),
    ) => Promise<ActionResult<{ id: string }>>
  >(async () => result);
}

const availableItems = [
  { id: 'i1', name: 'Furnace blower', categoryName: 'HVAC', archivedAt: null },
  { id: 'i2', name: 'Dishwasher', categoryName: 'Kitchen', archivedAt: null },
];
const availableSystems = [
  {
    id: 's1',
    name: 'HVAC system',
    kind: 'hvac',
    items: [{ id: 'i1', archivedAt: null }],
  },
];

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Performed on$/), '2026-01-15');
  await user.type(screen.getByLabelText(/^Summary$/), 'Annual tune-up');
}

describe('ServiceRecordForm with TargetsPicker', () => {
  it('renders an empty TargetsPicker when no initialTargets passed', () => {
    const action = makeAction({ ok: true, data: { id: 'sr-1' } });
    render(
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        vendors={[]}
        action={action}
        submitLabel="Save record"
      />,
    );
    // No selected chips visible
    expect(screen.queryByTestId('targets-picker-chips')).not.toBeInTheDocument();
  });

  it('pre-seeds the picker from initialTargets', () => {
    const action = makeAction({ ok: true, data: { id: 'sr-1' } });
    render(
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        vendors={[]}
        initialTargets={[{ itemId: 'i1' }]}
        action={action}
        submitLabel="Save record"
      />,
    );
    const chips = screen.getByTestId('targets-picker-chips');
    expect(chips).toHaveTextContent('Furnace blower');
  });

  it('blocks submit and surfaces an error when no vendor and no targets are selected', async () => {
    const action = makeAction({ ok: true, data: { id: 'sr-1' } });
    const user = userEvent.setup();
    render(
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        vendors={[]}
        action={action}
        submitLabel="Save record"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    await waitFor(() => {
      expect(screen.getByText(/pick a vendor.*or at least one item\/system/i)).toBeInTheDocument();
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('submits with targets: [{ itemId }] when one item is selected', async () => {
    const action = makeAction({ ok: true, data: { id: 'sr-new' } });
    const user = userEvent.setup();
    render(
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        vendors={[]}
        initialTargets={[{ itemId: 'i2' }]}
        action={action}
        submitLabel="Save record"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({
      targets: [{ itemId: 'i2' }],
      summary: 'Annual tune-up',
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/service/sr-new'));
  });

  it('submits with vendor only and zero targets (e.g. landscaping)', async () => {
    const action = makeAction({ ok: true, data: { id: 'sr-vendor-only' } });
    const user = userEvent.setup();
    render(
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={availableSystems}
        vendors={[{ id: 'v1', name: 'GreenLawn LLC' }]}
        defaultValues={{ vendorId: 'v1' }}
        action={action}
        submitLabel="Save record"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({
      targets: [],
      vendorId: 'v1',
      summary: 'Annual tune-up',
    });
  });

  it('submits with targets: [{ systemId }] when only a system is selected', async () => {
    // Use a system with no component items so auto-expand stays single-target.
    const action = makeAction({ ok: true, data: { id: 'sr-new' } });
    const user = userEvent.setup();
    render(
      <ServiceRecordForm
        availableItems={availableItems}
        availableSystems={[{ id: 's2', name: 'Plumbing', kind: 'plumbing', items: [] }]}
        vendors={[]}
        initialTargets={[{ systemId: 's2' }]}
        action={action}
        submitLabel="Save record"
      />,
    );
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[0]).toMatchObject({
      targets: [{ systemId: 's2' }],
    });
  });
});
