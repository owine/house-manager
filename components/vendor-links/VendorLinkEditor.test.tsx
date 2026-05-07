// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VendorLinkInput } from '@/lib/vendor-links/schema';
import { VendorLinkEditor, type VendorOption } from './VendorLinkEditor';

afterEach(() => {
  cleanup();
});

const VENDORS: VendorOption[] = [
  { id: 'v1', name: 'Acme Plumbing' },
  { id: 'v2', name: 'Bob the Builder' },
  { id: 'v3', name: 'Carol Electric' },
];

function renderEditor(opts?: {
  value?: VendorLinkInput | null;
  availableRoles?: import('@prisma/client').VendorRole[];
}) {
  const onChange = vi.fn<(next: VendorLinkInput) => void>();
  const utils = render(
    <VendorLinkEditor
      value={opts?.value ?? null}
      onChange={onChange}
      vendors={VENDORS}
      availableRoles={opts?.availableRoles}
    />,
  );
  return { onChange, ...utils };
}

describe('VendorLinkEditor', () => {
  it('initial render in existing-vendor mode shows Vendor select', () => {
    renderEditor({
      value: { vendorId: 'v2', freeformName: null, role: 'PURCHASE', notes: null },
    });
    expect(screen.getByLabelText('Vendor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Vendor name')).not.toBeInTheDocument();
  });

  it('initial render in free-text mode shows the typed name', () => {
    renderEditor({
      value: {
        vendorId: null,
        freeformName: 'Local handyman',
        role: 'INSTALLER',
        notes: null,
      },
    });
    const input = screen.getByLabelText('Vendor name') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('Local handyman');
  });

  it('switching modes clears the other side and preserves role', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      value: { vendorId: 'v2', freeformName: null, role: 'WARRANTY_PROVIDER', notes: 'foo' },
    });
    // Switch to free text
    await user.click(screen.getByRole('tab', { name: 'Free text' }));
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.vendorId).toBeNull();
    expect(last.freeformName).toBeNull();
    expect(last.role).toBe('WARRANTY_PROVIDER');
    expect(last.notes).toBe('foo');
  });

  it('switching from free text back to existing clears freeformName and preserves role', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      value: {
        vendorId: null,
        freeformName: 'someone',
        role: 'SERVICE',
        notes: null,
      },
    });
    await user.click(screen.getByRole('tab', { name: 'Pick existing vendor' }));
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.vendorId).toBeNull();
    expect(last.freeformName).toBeNull();
    expect(last.role).toBe('SERVICE');
  });

  it('typing free text fires onChange with vendorId null', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      value: { vendorId: null, freeformName: 'a', role: 'OTHER', notes: null },
    });
    const input = screen.getByLabelText('Vendor name');
    await user.clear(input);
    await user.type(input, 'X');
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.vendorId).toBeNull();
    expect(last.freeformName).toMatch(/X$/);
    expect(last.role).toBe('OTHER');
  });

  it('XOR invariant: every onChange call has exactly one of vendorId / freeformName', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      value: { vendorId: null, freeformName: '', role: 'OTHER', notes: null },
    });
    await user.click(screen.getByRole('tab', { name: 'Free text' }));
    await user.type(screen.getByLabelText('Vendor name'), 'abc');
    await user.click(screen.getByRole('tab', { name: 'Pick existing vendor' }));

    for (const call of onChange.mock.calls) {
      const v = call[0];
      const hasVendor = Boolean(v.vendorId);
      const hasFree = Boolean(v.freeformName);
      // XOR: at most one truthy. Allow neither when the user has not yet picked.
      expect(hasVendor && hasFree).toBe(false);
    }
  });

  it('availableRoles restricts the role select to the given subset', async () => {
    const user = userEvent.setup();
    renderEditor({
      value: { vendorId: 'v1', freeformName: null, role: 'PURCHASE', notes: null },
      availableRoles: ['PURCHASE', 'SERVICE'],
    });
    // Open the role select
    const roleTrigger = screen.getByLabelText('Role');
    await user.click(roleTrigger);
    expect(await screen.findByRole('option', { name: 'PURCHASE' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SERVICE' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'INSTALLER' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'WARRANTY_PROVIDER' })).not.toBeInTheDocument();
  });

  it('changing role fires onChange preserving the freeform name', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      value: { vendorId: null, freeformName: 'Bob', role: 'PURCHASE', notes: null },
    });
    const roleTrigger = screen.getByLabelText('Role');
    await user.click(roleTrigger);
    await user.click(await screen.findByRole('option', { name: 'INSTALLER' }));
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.role).toBe('INSTALLER');
    expect(last.freeformName).toBe('Bob');
    expect(last.vendorId).toBeNull();
  });

  it('selecting a vendor fires onChange with vendorId set and freeformName null', async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      value: { vendorId: null, freeformName: null, role: 'PURCHASE', notes: null },
    });
    const vendorTrigger = screen.getByLabelText('Vendor');
    await user.click(vendorTrigger);
    await user.click(await screen.findByRole('option', { name: 'Bob the Builder' }));
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.vendorId).toBe('v2');
    expect(last.freeformName).toBeNull();
    expect(last.role).toBe('PURCHASE');
  });
});
