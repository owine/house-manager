// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetInput } from '@/lib/targets/schema';
import { expectNoAxeViolations } from '@/tests/a11y/axe';
import { type AvailableItem, type AvailableSystem, TargetsPicker } from './TargetsPicker';

afterEach(() => {
  cleanup();
});

async function expandSections(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Systems/ }));
  await user.click(screen.getByRole('button', { name: /^Items/ }));
}

const item = (
  id: string,
  name: string,
  categoryName: string | null = 'Appliance',
  archivedAt: Date | null = null,
): AvailableItem => ({ id, name, categoryName, archivedAt });

const system = (
  id: string,
  name: string,
  items: Array<{ id: string; archivedAt: Date | null }> = [],
  kind: string | null = 'hvac',
): AvailableSystem => ({ id, name, kind, items });

function setup(initialValue: TargetInput[] = []) {
  const onChange = vi.fn<(next: TargetInput[]) => void>();
  const items: AvailableItem[] = [
    item('i1', 'Furnace blower'),
    item('i2', 'AC condenser'),
    item('i3', 'Dishwasher', 'Kitchen'),
  ];
  const systems: AvailableSystem[] = [
    system('s1', 'HVAC', [
      { id: 'i1', archivedAt: null },
      { id: 'i2', archivedAt: null },
      { id: 'iArchived', archivedAt: new Date('2025-01-01') },
    ]),
    system('s2', 'Plumbing', [], 'plumbing'),
  ];

  const utils = render(
    <TargetsPicker
      value={initialValue}
      onChange={onChange}
      availableItems={items}
      availableSystems={systems}
    />,
  );

  return { onChange, items, systems, ...utils };
}

describe('TargetsPicker', () => {
  it('renders both Systems and Items sections with provided rows', async () => {
    const user = userEvent.setup();
    setup();
    await expandSections(user);
    expect(screen.getByText('Systems')).toBeInTheDocument();
    expect(screen.getByText('Items')).toBeInTheDocument();
    expect(screen.getByText('HVAC')).toBeInTheDocument();
    expect(screen.getByText('Plumbing')).toBeInTheDocument();
    expect(screen.getByText('Furnace blower')).toBeInTheDocument();
    expect(screen.getByText('AC condenser')).toBeInTheDocument();
    expect(screen.getByText('Dishwasher')).toBeInTheDocument();
    // Category groupings rendered
    expect(screen.getByText('Appliance')).toBeInTheDocument();
    expect(screen.getByText('Kitchen')).toBeInTheDocument();
  });

  it('checking an item adds it to onChange payload', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await expandSections(user);
    const itemsList = screen.getByTestId('targets-picker-items-list');
    await user.click(within(itemsList).getByRole('checkbox', { name: 'Dishwasher' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ itemId: 'i3' }]);
  });

  it('checking a system auto-expands to include its active component items', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await expandSections(user);
    const systemsList = screen.getByTestId('targets-picker-systems-list');
    await user.click(within(systemsList).getByRole('checkbox', { name: /^HVAC/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // System added
    expect(next).toContainEqual({ systemId: 's1' });
    // Active components added
    expect(next).toContainEqual({ itemId: 'i1' });
    expect(next).toContainEqual({ itemId: 'i2' });
    // Archived component NOT included
    expect(next.some((t) => t.itemId === 'iArchived')).toBe(false);
  });

  it('shows pre-selected items as checked', async () => {
    const user = userEvent.setup();
    setup([{ itemId: 'i1' }]);
    await expandSections(user);
    const itemsList = screen.getByTestId('targets-picker-items-list');
    const cb = within(itemsList).getByRole('checkbox', { name: 'Furnace blower' });
    expect(cb).toHaveAttribute('aria-checked', 'true');
  });

  it('search filters both sections case-insensitively', async () => {
    const user = userEvent.setup();
    setup();
    await expandSections(user);
    const search = screen.getByLabelText('Filter targets');
    await user.type(search, 'plumb');
    // Plumbing system still visible
    expect(screen.getByText('Plumbing')).toBeInTheDocument();
    // HVAC system filtered out
    expect(screen.queryByText('HVAC')).not.toBeInTheDocument();
    // No items match → empty state in items list
    expect(screen.getByText('no items match.')).toBeInTheDocument();
  });

  it('unchecking an item does not uncheck its system', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([{ systemId: 's1' }, { itemId: 'i1' }, { itemId: 'i2' }]);
    await expandSections(user);
    // Uncheck the i1 item
    const itemsList = screen.getByTestId('targets-picker-items-list');
    await user.click(within(itemsList).getByRole('checkbox', { name: 'Furnace blower' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toContainEqual({ systemId: 's1' });
    expect(next).toContainEqual({ itemId: 'i2' });
    expect(next.some((t) => t.itemId === 'i1')).toBe(false);
  });

  it('unchecking a system does not auto-uncheck its components', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([{ systemId: 's1' }, { itemId: 'i1' }, { itemId: 'i2' }]);
    await expandSections(user);
    const systemsList = screen.getByTestId('targets-picker-systems-list');
    await user.click(within(systemsList).getByRole('checkbox', { name: /^HVAC/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.some((t) => t.systemId === 's1')).toBe(false);
    expect(next).toContainEqual({ itemId: 'i1' });
    expect(next).toContainEqual({ itemId: 'i2' });
  });

  it('chip strip removes a target when X is clicked', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([{ systemId: 's1' }, { itemId: 'i3' }]);
    const chips = screen.getByTestId('targets-picker-chips');
    const removeItemBtn = within(chips).getByRole('button', {
      name: /Remove item Dishwasher/,
    });
    await user.click(removeItemBtn);
    expect(onChange).toHaveBeenCalledWith([{ systemId: 's1' }]);
  });

  it('shows empty state when no items or systems are provided', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TargetsPicker value={[]} onChange={onChange} availableItems={[]} availableSystems={[]} />,
    );
    await expandSections(user);
    expect(screen.getByText('no systems match.')).toBeInTheDocument();
    expect(screen.getByText('no items match.')).toBeInTheDocument();
  });

  it('does not render archived items even if passed by parent', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TargetsPicker
        value={[]}
        onChange={onChange}
        availableItems={[
          item('iArchived', 'Old furnace', 'Appliance', new Date('2025-01-01')),
          item('iLive', 'Live item'),
        ]}
        availableSystems={[]}
      />,
    );
    await expandSections(user);
    expect(screen.queryByText('Old furnace')).not.toBeInTheDocument();
    expect(screen.getByText('Live item')).toBeInTheDocument();
  });

  it('keeps a selected target visible as a chip even when filtered out of view', async () => {
    const user = userEvent.setup();
    setup([{ itemId: 'i3' }]);
    await expandSections(user);
    const search = screen.getByLabelText('Filter targets');
    await user.type(search, 'furn');
    // Dishwasher row not rendered in items list any more
    const itemsList = screen.getByTestId('targets-picker-items-list');
    expect(within(itemsList).queryByText('Dishwasher')).not.toBeInTheDocument();
    // But the chip is still there
    const chips = screen.getByTestId('targets-picker-chips');
    expect(within(chips).getByText('Dishwasher')).toBeInTheDocument();
  });

  it('both sections start collapsed (lists hidden on mount)', () => {
    setup([{ systemId: 's1' }, { itemId: 'i1' }]);
    expect(screen.queryByTestId('targets-picker-systems-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('targets-picker-items-list')).not.toBeInTheDocument();
  });

  it('collapsed headers show a selected-count badge only when > 0', () => {
    const { rerender } = render(
      <TargetsPicker value={[]} onChange={vi.fn()} availableItems={[]} availableSystems={[]} />,
    );
    expect(screen.queryByText('selected', { exact: false })).not.toBeInTheDocument();
    rerender(
      <TargetsPicker
        value={[{ systemId: 's1' }, { itemId: 'i1' }, { itemId: 'i2' }]}
        onChange={vi.fn()}
        availableItems={[]}
        availableSystems={[]}
      />,
    );
    expect(screen.getByText('1 selected')).toBeInTheDocument(); // systems
    expect(screen.getByText('2 selected')).toBeInTheDocument(); // items
  });

  it('has no axe violations', async () => {
    setup();
    await expectNoAxeViolations();
  });

  it('expanding a collapsed section reveals its list', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByTestId('targets-picker-items-list')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Items/ }));
    expect(screen.getByTestId('targets-picker-items-list')).toBeInTheDocument();
  });
});
