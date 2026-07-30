// @vitest-environment jsdom
//
// Reserved (`_`-prefixed) metadata keys are internal bookkeeping — see
// lib/metadata/reserved-keys.ts, whose comment lists the read path as a third
// enforcement point precisely because it was missed once (#328) and rendered
// `_provenance` as a raw JSON row on the item detail page. A part's Spec card
// enumerates a metadata blob the same way, so it needs the same filter, and
// this pins it from day one rather than after the leak.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { OverviewTab } from './OverviewTab';

afterEach(() => {
  cleanup();
});

type PartProp = Parameters<typeof OverviewTab>[0]['part'];

// `getPart` returns a deeply nested payload (links, reminderTargets,
// serviceRecordTargets, attachments). OverviewTab reads nine scalar fields of
// it. `satisfies Partial<PartProp>` type-checks every field that IS present —
// a typo'd key or wrong type still fails the build; only omissions are
// unchecked. Same trade-off as the item-side twin.
function makePart(metadata: NonNullable<PartProp['metadata']>): PartProp {
  const part = {
    id: 'p1',
    name: 'Kitchen can light bulb',
    kind: 'BULB',
    location: 'Kitchen',
    manufacturer: null,
    model: null,
    sku: null,
    typicalCost: null,
    packQuantity: null,
    purchaseLinks: [],
    metadata,
    notes: null,
    archivedAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  } satisfies Partial<PartProp>;

  return part as unknown as PartProp;
}

describe('part OverviewTab reserved metadata keys', () => {
  it('does not render a reserved key or its value', () => {
    render(
      <OverviewTab
        part={makePart({
          _provenance: { name: 'user', watts: 'inferred' },
          colorTempK: 2700,
        })}
      />,
    );

    expect(screen.getByText('Color Temp K')).toBeInTheDocument();
    expect(screen.getByText('2700')).toBeInTheDocument();

    expect(screen.queryByText(/_provenance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provenance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/inferred/)).not.toBeInTheDocument();
  });

  it('hides the Spec card entirely when only reserved keys remain', () => {
    render(<OverviewTab part={makePart({ _provenance: { name: 'user' } })} />);

    // An empty card with a heading and no rows is the failure mode here.
    expect(screen.queryByText('Spec')).not.toBeInTheDocument();
  });

  it('still renders the card when at least one non-reserved key exists', () => {
    render(<OverviewTab part={makePart({ _provenance: { name: 'user' }, base: 'E26' })} />);

    expect(screen.getByText('Spec')).toBeInTheDocument();
    expect(screen.getByText('E26')).toBeInTheDocument();
  });
});
