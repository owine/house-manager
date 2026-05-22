// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '@/tests/a11y/axe';
import {
  type ConvertVendorLinksAction,
  type DeleteVendorAndLinksAction,
  DeleteVendorDialog,
  type TryDeleteVendorAction,
} from './DeleteVendorDialog';

afterEach(() => {
  cleanup();
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function setup(
  overrides: Partial<React.ComponentProps<typeof DeleteVendorDialog>> & {
    itemCount?: number;
    systemCount?: number;
  } = {},
) {
  const tryDeleteAction: TryDeleteVendorAction =
    overrides.tryDeleteAction ?? vi.fn<TryDeleteVendorAction>(async () => ({ ok: true }));
  const convertAction: ConvertVendorLinksAction =
    overrides.convertAction ??
    vi.fn<ConvertVendorLinksAction>(async () => ({
      ok: true,
      convertedItemCount: 0,
      convertedSystemCount: 0,
    }));
  const deleteWithLinksAction: DeleteVendorAndLinksAction =
    overrides.deleteWithLinksAction ??
    vi.fn<DeleteVendorAndLinksAction>(async () => ({
      ok: true,
      deletedItemCount: 0,
      deletedSystemCount: 0,
    }));
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const onSuccess = overrides.onSuccess ?? vi.fn();

  const utils = render(
    <DeleteVendorDialog
      vendorId="v1"
      vendorName="ACME Plumbing"
      itemCount={overrides.itemCount ?? 0}
      systemCount={overrides.systemCount ?? 0}
      open
      onOpenChange={onOpenChange}
      tryDeleteAction={tryDeleteAction}
      convertAction={convertAction}
      deleteWithLinksAction={deleteWithLinksAction}
      onSuccess={onSuccess}
      {...overrides}
    />,
  );

  return {
    tryDeleteAction,
    convertAction,
    deleteWithLinksAction,
    onOpenChange,
    onSuccess,
    ...utils,
  };
}

describe('DeleteVendorDialog', () => {
  it('renders confirm UI for the no-links case', () => {
    setup();
    expect(screen.getByTestId('delete-vendor-no-links')).toBeInTheDocument();
    expect(screen.getByTestId('delete-vendor-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-vendor-has-links')).not.toBeInTheDocument();
  });

  it('plain delete calls tryDeleteAction and fires success', async () => {
    const user = userEvent.setup();
    const { tryDeleteAction, onSuccess } = setup();
    await user.click(screen.getByTestId('delete-vendor-confirm'));
    await waitFor(() => expect(tryDeleteAction).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('renders both options for the has-links case', () => {
    setup({ itemCount: 3, systemCount: 1 });
    expect(screen.getByTestId('delete-vendor-has-links')).toBeInTheDocument();
    expect(screen.getByTestId('delete-vendor-convert')).toBeInTheDocument();
    expect(screen.getByTestId('delete-vendor-cascade')).toBeInTheDocument();
    expect(screen.getByTestId('delete-vendor-has-links')).toHaveTextContent('3 items and 1 system');
  });

  it('convert action fires with the right vendorId', async () => {
    const user = userEvent.setup();
    const { convertAction, onSuccess } = setup({ itemCount: 2, systemCount: 0 });
    await user.click(screen.getByTestId('delete-vendor-convert'));
    await waitFor(() => expect(convertAction).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('delete-with-links requires a double confirm before firing', async () => {
    const user = userEvent.setup();
    const { deleteWithLinksAction, onSuccess } = setup({ itemCount: 2, systemCount: 1 });
    const cascade = screen.getByTestId('delete-vendor-cascade');

    await user.click(cascade);
    expect(deleteWithLinksAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-vendor-confirm-cascade')).toBeInTheDocument();
    expect(cascade).toHaveTextContent(/Confirm delete/);

    await user.click(cascade);
    await waitFor(() => expect(deleteWithLinksAction).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('has no axe violations', async () => {
    setup();
    await screen.findByRole('dialog'); // ensure the portaled dialog content is committed before scanning
    await expectNoAxeViolations();
  });

  it('shows formError from a failed action', async () => {
    const user = userEvent.setup();
    const tryDeleteAction = vi.fn<TryDeleteVendorAction>(async () => ({
      ok: false,
      formError: 'Boom',
    }));
    setup({ tryDeleteAction });
    await user.click(screen.getByTestId('delete-vendor-confirm'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Boom'));
  });
});
