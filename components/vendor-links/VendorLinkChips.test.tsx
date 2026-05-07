// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VendorLinkChips, type VendorLinkRow } from './VendorLinkChips';

afterEach(() => {
  cleanup();
});

const LINKS: VendorLinkRow[] = [
  {
    id: 'l1',
    vendorId: 'v1',
    vendorName: 'Acme Plumbing',
    freeformName: null,
    role: 'PURCHASE',
    notes: null,
    serviceContract: false,
    contractEndsOn: null,
  },
  {
    id: 'l2',
    vendorId: null,
    vendorName: null,
    freeformName: 'Local handyman',
    role: 'INSTALLER',
    notes: 'Cash only',
    serviceContract: false,
    contractEndsOn: null,
  },
];

describe('VendorLinkChips', () => {
  it('renders one chip per link', () => {
    render(<VendorLinkChips links={LINKS} />);
    const list = screen.getByTestId('vendor-link-chips');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('vendor-link-chip-l1')).toBeInTheDocument();
    expect(screen.getByTestId('vendor-link-chip-l2')).toBeInTheDocument();
  });

  it('vendor-linked chip shows vendor name wrapped in a link by default', () => {
    render(<VendorLinkChips links={LINKS} />);
    const link = screen.getByTestId('vendor-link-chip-link-l1');
    expect(link).toHaveAttribute('href', '/vendors/v1');
    expect(link).toHaveTextContent('Acme Plumbing');
  });

  it('vendor-linked chip omits the link when linkVendorPages is false', () => {
    render(<VendorLinkChips links={LINKS} linkVendorPages={false} />);
    expect(screen.queryByTestId('vendor-link-chip-link-l1')).not.toBeInTheDocument();
    // Plain text fallback present
    expect(screen.getByTestId('vendor-link-chip-text-l1')).toHaveTextContent('Acme Plumbing');
  });

  it('free-text chip shows freeform name without a link', () => {
    render(<VendorLinkChips links={LINKS} />);
    expect(screen.queryByTestId('vendor-link-chip-link-l2')).not.toBeInTheDocument();
    expect(screen.getByTestId('vendor-link-chip-text-l2')).toHaveTextContent('Local handyman');
  });

  it('renders the role badge label for each chip', () => {
    render(<VendorLinkChips links={LINKS} />);
    const chip1 = screen.getByTestId('vendor-link-chip-l1');
    const chip2 = screen.getByTestId('vendor-link-chip-l2');
    expect(within(chip1).getByText('PURCHASE')).toBeInTheDocument();
    expect(within(chip2).getByText('INSTALLER')).toBeInTheDocument();
  });

  it('edit/delete buttons appear only when callbacks are provided', () => {
    const { rerender } = render(<VendorLinkChips links={LINKS} />);
    expect(screen.queryByTestId('vendor-link-chip-edit-l1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vendor-link-chip-delete-l1')).not.toBeInTheDocument();

    rerender(<VendorLinkChips links={LINKS} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByTestId('vendor-link-chip-edit-l1')).toBeInTheDocument();
    expect(screen.getByTestId('vendor-link-chip-delete-l1')).toBeInTheDocument();
  });

  it('clicking edit/delete fires the callbacks with the link id', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<VendorLinkChips links={LINKS} onEdit={onEdit} onDelete={onDelete} />);

    await user.click(screen.getByTestId('vendor-link-chip-edit-l1'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('l1');

    await user.click(screen.getByTestId('vendor-link-chip-delete-l2'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('l2');
  });

  it('shows empty state when no links provided', () => {
    render(<VendorLinkChips links={[]} />);
    expect(screen.getByTestId('vendor-link-chips-empty')).toBeInTheDocument();
  });

  it('does not show a contract badge when serviceContract is false', () => {
    render(<VendorLinkChips links={LINKS} />);
    expect(screen.queryByTestId('vendor-link-chip-contract-l1')).not.toBeInTheDocument();
  });

  it('shows "Contract" badge when serviceContract is true and no end date', () => {
    const links: VendorLinkRow[] = [{ ...LINKS[0], serviceContract: true, contractEndsOn: null }];
    render(<VendorLinkChips links={links} />);
    const badge = screen.getByTestId('vendor-link-chip-contract-l1');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Contract');
  });

  it('shows "Contract → <date>" badge when serviceContract is true with an end date', () => {
    const links: VendorLinkRow[] = [
      { ...LINKS[0], serviceContract: true, contractEndsOn: new Date('2027-06-30T00:00:00.000Z') },
    ];
    render(<VendorLinkChips links={links} />);
    const badge = screen.getByTestId('vendor-link-chip-contract-l1');
    expect(badge).toHaveTextContent('Contract → Jun 30, 2027');
  });
});
