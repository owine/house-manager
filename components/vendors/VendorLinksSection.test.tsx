// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VendorLinksSection } from './VendorLinksSection';

afterEach(() => {
  cleanup();
});

describe('VendorLinksSection', () => {
  it('renders empty state when no links', () => {
    render(<VendorLinksSection items={[]} systems={[]} />);
    expect(screen.getByTestId('vendor-links-empty')).toBeInTheDocument();
  });

  it('nests items under their parent system when both share a role', () => {
    render(
      <VendorLinksSection
        items={[
          {
            id: 'iv-hp',
            itemId: 'hp',
            freeformName: null,
            role: 'INSTALLER',
            item: { id: 'hp', name: 'Heat Pump', systemId: 'hvac' },
          },
          {
            id: 'iv-furnace',
            itemId: 'fu',
            freeformName: null,
            role: 'INSTALLER',
            item: { id: 'fu', name: 'Furnace', systemId: 'hvac' },
          },
        ]}
        systems={[
          {
            id: 'sv-hvac',
            systemId: 'hvac',
            freeformName: null,
            role: 'INSTALLER',
            system: { id: 'hvac', name: 'HVAC' },
          },
        ]}
      />,
    );

    // Children list rendered under the HVAC system row.
    const children = screen.getByTestId('vendor-link-children-sv-hvac');
    expect(within(children).getByText('Heat Pump')).toBeInTheDocument();
    expect(within(children).getByText('Furnace')).toBeInTheDocument();
  });

  it('keeps items at the top level when their parent system is not linked at the same role', () => {
    // Heat Pump is in HVAC (per item.systemId), but the vendor's HVAC link is
    // SERVICE, not INSTALLER. So Heat Pump (INSTALLER) renders flat.
    render(
      <VendorLinksSection
        items={[
          {
            id: 'iv-hp',
            itemId: 'hp',
            freeformName: null,
            role: 'INSTALLER',
            item: { id: 'hp', name: 'Heat Pump', systemId: 'hvac' },
          },
        ]}
        systems={[
          {
            id: 'sv-hvac',
            systemId: 'hvac',
            freeformName: null,
            role: 'SERVICE',
            system: { id: 'hvac', name: 'HVAC' },
          },
        ]}
      />,
    );
    // No "children" list under HVAC for SERVICE role.
    expect(screen.queryByTestId('vendor-link-children-sv-hvac')).not.toBeInTheDocument();
    // Heat Pump still renders at top level.
    expect(screen.getByTestId('vendor-linked-item-iv-hp')).toBeInTheDocument();
  });

  it('renders standalone items (no system) at the top level', () => {
    render(
      <VendorLinksSection
        items={[
          {
            id: 'iv-fridge',
            itemId: 'fr',
            freeformName: null,
            role: 'PURCHASE',
            item: { id: 'fr', name: 'Fridge', systemId: null },
          },
        ]}
        systems={[]}
      />,
    );
    expect(screen.getByTestId('vendor-linked-item-iv-fridge')).toHaveTextContent('Fridge');
  });

  it('groups by role with stable order', () => {
    render(
      <VendorLinksSection
        items={[
          {
            id: 'iv-fridge',
            itemId: 'fr',
            freeformName: null,
            role: 'PURCHASE',
            item: { id: 'fr', name: 'Fridge', systemId: null },
          },
        ]}
        systems={[
          {
            id: 'sv-hvac',
            systemId: 'hvac',
            freeformName: null,
            role: 'SERVICE',
            system: { id: 'hvac', name: 'HVAC' },
          },
        ]}
      />,
    );
    // PURCHASE comes before SERVICE in ROLE_ORDER.
    const sections = screen.getByTestId('vendor-links').querySelectorAll('section');
    expect(sections).toHaveLength(2);
    expect(within(sections[0] as HTMLElement).getByText(/purchase/i)).toBeInTheDocument();
    expect(within(sections[1] as HTMLElement).getByText(/service/i)).toBeInTheDocument();
  });

  it('renders freeform link names when no item/system row is attached', () => {
    render(
      <VendorLinksSection
        items={[
          {
            id: 'iv-lg',
            itemId: 'gone',
            freeformName: 'LG Electronics',
            role: 'MANUFACTURER',
            item: null,
          },
        ]}
        systems={[]}
      />,
    );
    expect(screen.getByText('LG Electronics')).toBeInTheDocument();
  });
});
