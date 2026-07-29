// @vitest-environment jsdom
//
// Reserved (`_`-prefixed) metadata keys are internal bookkeeping — see
// lib/metadata/reserved-keys.ts. `_provenance` is written directly via Prisma
// by conversational capture to record which fields the model inferred rather
// than being told.
//
// The prefix had enforcement at the write path (lib/categories.ts rejects such
// keys) and the embedding path (lib/embedding/canonicalize.ts drops them from
// canonical text), and its own comment enumerated those two as though the list
// were complete. The READ path was missed, so an AI-captured item rendered
//
//     _provenance   {"name":"user","model":"user","location":"inferred"}
//
// as a row in the Additional Details card.
//
// These tests pin the read-path filter. The `hasMetadata` case matters as much
// as the row case: without it an item whose metadata is *only* reserved keys
// renders an empty card with a heading and no content.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { OverviewTab } from './OverviewTab';

afterEach(() => {
  cleanup();
});

type ItemProp = Parameters<typeof OverviewTab>[0]['item'];

function makeItem(metadata: Record<string, unknown>): ItemProp {
  return {
    id: 'i1',
    name: 'Backyard String Lights',
    categoryId: 'c1',
    category: { id: 'c1', slug: 'other', name: 'Other', icon: null, sortOrder: 0 },
    systemId: null,
    system: null,
    location: 'Backyard',
    manufacturer: null,
    model: null,
    serialNumber: null,
    purchaseDate: null,
    purchasePrice: null,
    metadata,
    notes: null,
    archivedAt: null,
    restoredAt: null,
    includeInSuggestions: true,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  } as unknown as ItemProp;
}

describe('OverviewTab reserved metadata keys', () => {
  it('does not render a reserved key or its value', () => {
    render(
      <OverviewTab
        item={makeItem({
          _provenance: { name: 'user', model: 'user', location: 'inferred' },
          colorTempK: 2700,
        })}
      />,
    );

    // The visible spec field still renders...
    expect(screen.getByText('Color Temp K')).toBeInTheDocument();
    expect(screen.getByText('2700')).toBeInTheDocument();

    // ...and the reserved key does not, in either its raw or its
    // toLabel()-prettified form, nor does its serialized value leak.
    expect(screen.queryByText(/_provenance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Provenance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/inferred/)).not.toBeInTheDocument();
  });

  it('hides the Additional Details card entirely when only reserved keys remain', () => {
    render(<OverviewTab item={makeItem({ _provenance: { name: 'user' } })} />);

    // An empty card with a heading and no rows is the failure mode here.
    expect(screen.queryByText('Additional Details')).not.toBeInTheDocument();
  });

  it('still renders the card when at least one non-reserved key exists', () => {
    render(<OverviewTab item={makeItem({ _provenance: { name: 'user' }, base: 'E26' })} />);

    expect(screen.getByText('Additional Details')).toBeInTheDocument();
    expect(screen.getByText('E26')).toBeInTheDocument();
  });
});
