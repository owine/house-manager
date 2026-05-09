// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type TargetSummary, TargetsChips } from './TargetsChips';

afterEach(() => {
  cleanup();
});

const TARGETS: TargetSummary[] = [
  {
    id: 't1',
    itemId: 'i1',
    systemId: null,
    item: { id: 'i1', name: 'Furnace' },
    system: null,
  },
  {
    id: 't2',
    itemId: null,
    systemId: 's1',
    item: null,
    system: { id: 's1', name: 'HVAC' },
  },
];

describe('TargetsChips', () => {
  it('renders one chip per target', () => {
    render(<TargetsChips targets={TARGETS} />);
    const list = screen.getByTestId('targets-chips');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('item chip links to /items/<id> with Item badge', () => {
    render(<TargetsChips targets={TARGETS} />);
    const link = screen.getByTestId('targets-chip-link-t1');
    expect(link).toHaveAttribute('href', '/items/i1');
    expect(link).toHaveTextContent('Furnace');
    expect(within(screen.getByTestId('targets-chip-t1')).getByText('Item')).toBeInTheDocument();
  });

  it('system chip links to /systems/<id> with System badge', () => {
    render(<TargetsChips targets={TARGETS} />);
    const link = screen.getByTestId('targets-chip-link-t2');
    expect(link).toHaveAttribute('href', '/systems/s1');
    expect(link).toHaveTextContent('HVAC');
    expect(within(screen.getByTestId('targets-chip-t2')).getByText('System')).toBeInTheDocument();
  });

  it('inert mode renders text instead of links', () => {
    render(<TargetsChips targets={TARGETS} inert />);
    expect(screen.queryByTestId('targets-chip-link-t1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('targets-chip-link-t2')).not.toBeInTheDocument();
    expect(screen.getByTestId('targets-chip-text-t1')).toHaveTextContent('Furnace');
    expect(screen.getByTestId('targets-chip-text-t2')).toHaveTextContent('HVAC');
  });

  it('renders an em-dash placeholder for empty/orphan targets', () => {
    render(<TargetsChips targets={[]} />);
    expect(screen.getByTestId('targets-chips-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('targets-chips')).not.toBeInTheDocument();
  });

  it('skips targets that have neither item nor system populated', () => {
    render(
      <TargetsChips
        targets={[
          { id: 'orphan', itemId: null, systemId: null, item: null, system: null },
          ...TARGETS,
        ]}
      />,
    );
    const list = screen.getByTestId('targets-chips');
    // Only the two well-formed targets render.
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('dedups item chips whose parent system is also in the target set', () => {
    // System "HVAC" + two of its items + an unrelated item. The two items
    // belonging to HVAC should be hidden (the system implies them); the
    // unrelated item stays.
    render(
      <TargetsChips
        targets={[
          {
            id: 'sys',
            itemId: null,
            systemId: 'hvac',
            item: null,
            system: { id: 'hvac', name: 'HVAC' },
          },
          {
            id: 'i-hp',
            itemId: 'hp',
            systemId: null,
            item: { id: 'hp', name: 'Heat Pump', systemId: 'hvac' },
            system: null,
          },
          {
            id: 'i-furnace',
            itemId: 'fu',
            systemId: null,
            item: { id: 'fu', name: 'Furnace', systemId: 'hvac' },
            system: null,
          },
          {
            id: 'i-fridge',
            itemId: 'fr',
            systemId: null,
            item: { id: 'fr', name: 'Fridge', systemId: null },
            system: null,
          },
        ]}
      />,
    );
    const list = screen.getByTestId('targets-chips');
    // Two chips render: the HVAC system + the unrelated Fridge item.
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByTestId('targets-chip-i-hp')).not.toBeInTheDocument();
    expect(screen.queryByTestId('targets-chip-i-furnace')).not.toBeInTheDocument();
    expect(screen.getByTestId('targets-chip-sys')).toBeInTheDocument();
    expect(screen.getByTestId('targets-chip-i-fridge')).toBeInTheDocument();
  });

  it('keeps an item chip when its parent system is NOT in the target set', () => {
    // Item belongs to a system, but the system isn't a target — chip stays.
    render(
      <TargetsChips
        targets={[
          {
            id: 'i-hp',
            itemId: 'hp',
            systemId: null,
            item: { id: 'hp', name: 'Heat Pump', systemId: 'hvac' },
            system: null,
          },
        ]}
      />,
    );
    expect(screen.getByTestId('targets-chip-i-hp')).toBeInTheDocument();
  });
});
