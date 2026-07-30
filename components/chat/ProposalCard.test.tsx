// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurnProposal } from '@/lib/chat/actions';
import type { ActionResult } from '@/lib/result';
import { ProposalCard } from './ProposalCard';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => cleanup());

function makeProposal(overrides: Partial<ChatTurnProposal> = {}): ChatTurnProposal {
  return {
    id: 'prop-1',
    kind: 'CREATE_SERVICE_RECORD',
    targetType: 'SERVICE_RECORD',
    targetId: null,
    payload: {
      kind: 'CREATE_SERVICE_RECORD',
      summary: { value: 'Reset water heater', source: 'user' },
      performedOn: { value: '2026-07-03', source: 'inferred' },
      notes: undefined,
      selfPerformed: true,
      targets: [],
    },
    status: 'PENDING',
    baseUpdatedAt: null,
    beforeSnapshot: null,
    ...overrides,
  };
}

function noopApply(): Promise<ActionResult<{ id: string }>> {
  return Promise.resolve({ ok: true, data: { id: 'x' } });
}
function noopRefresh(): Promise<ActionResult<{ proposal: ChatTurnProposal }>> {
  return Promise.resolve({ ok: true, data: { proposal: makeProposal() } });
}

describe('ProposalCard', () => {
  it('renders the proposal kind as a human label', () => {
    render(
      <ProposalCard
        proposal={makeProposal()}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByText('New service record')).toBeInTheDocument();
  });

  it('renders the human label for an update kind', () => {
    render(
      <ProposalCard
        proposal={makeProposal({
          kind: 'UPDATE_ITEM',
          targetType: 'ITEM',
          targetId: 'item-1',
          payload: {
            kind: 'UPDATE_ITEM',
            itemId: 'item-1',
            location: { value: 'Basement', source: 'user' },
          },
          beforeSnapshot: { location: 'Garage' },
        })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByText('Update item')).toBeInTheDocument();
  });

  it('renders a before/after pair for update kinds', () => {
    render(
      <ProposalCard
        proposal={makeProposal({
          kind: 'UPDATE_ITEM',
          targetType: 'ITEM',
          targetId: 'item-1',
          payload: {
            kind: 'UPDATE_ITEM',
            itemId: 'item-1',
            location: { value: 'Basement', source: 'user' },
          },
          beforeSnapshot: { location: 'Garage' },
        })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.getByText('Basement')).toBeInTheDocument();
  });

  it('renders a single value with no before for a create kind', () => {
    render(
      <ProposalCard
        proposal={makeProposal()}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByText('Reset water heater')).toBeInTheDocument();
    // No strike-through "before" value exists for a create.
    expect(screen.queryByText('Garage')).not.toBeInTheDocument();
  });

  it('renders an inferred badge on fields whose source is inferred', () => {
    render(
      <ProposalCard
        proposal={makeProposal()}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    // performedOn is 'inferred'; summary is 'user' and must not get a badge.
    expect(screen.getAllByText('inferred')).toHaveLength(1);
  });

  it('renders no badge on a user-sourced field', () => {
    render(
      <ProposalCard
        proposal={makeProposal({
          payload: {
            kind: 'CREATE_SERVICE_RECORD',
            summary: { value: 'Reset water heater', source: 'user' },
            performedOn: { value: '2026-07-03', source: 'user' },
            notes: undefined,
            selfPerformed: true,
            targets: [],
          },
        })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.queryByText('inferred')).not.toBeInTheDocument();
  });

  it('calls applyProposal with the proposal id on Accept', async () => {
    const applyProposal = vi.fn(noopApply);
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={makeProposal()}
        applyProposal={applyProposal}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(applyProposal).toHaveBeenCalledWith('prop-1'));
  });

  it('calls rejectProposal with the proposal id on Reject', async () => {
    const rejectProposal = vi.fn(noopApply);
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={makeProposal()}
        applyProposal={noopApply}
        rejectProposal={rejectProposal}
        refreshProposal={noopRefresh}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(rejectProposal).toHaveBeenCalledWith('prop-1'));
  });

  it('renders a "Review changes" affordance instead of Accept for a STALE proposal, bound to refreshProposal', async () => {
    const refreshProposal = vi.fn(noopRefresh);
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={makeProposal({ status: 'STALE' })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={refreshProposal}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    const reviewButton = screen.getByRole('button', { name: 'Review changes' });
    await user.click(reviewButton);
    await waitFor(() => expect(refreshProposal).toHaveBeenCalledWith('prop-1'));
  });

  it('does not auto-apply on refresh — status returns to PENDING for re-confirmation', async () => {
    const refreshed = makeProposal({
      status: 'PENDING',
      payload: {
        kind: 'CREATE_SERVICE_RECORD',
        summary: { value: 'Reset water heater (again)', source: 'user' },
        performedOn: { value: '2026-07-04', source: 'inferred' },
        notes: undefined,
        selfPerformed: true,
        targets: [],
      },
    });
    const refreshProposal = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { proposal: refreshed } }),
    );
    const user = userEvent.setup();
    render(
      <ProposalCard
        proposal={makeProposal({ status: 'STALE' })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={refreshProposal}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    // The refreshed diff renders; Accept is available again, nothing auto-applied.
    await screen.findByText('Reset water heater (again)');
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });

  it('explains an ORPHANED proposal and renders no action buttons', () => {
    render(
      <ProposalCard
        proposal={makeProposal({ status: 'ORPHANED' })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByText(/record this proposal refers to was deleted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains an INVALID proposal with different wording than ORPHANED, and renders no action buttons', () => {
    render(
      <ProposalCard
        proposal={makeProposal({ status: 'INVALID' })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );
    expect(screen.getByText(/predates a schema change/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/record this proposal refers to was deleted/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ProposalCard — part proposals', () => {
  it('renders each spec field as its own diff row, with a readable label', () => {
    render(
      <ProposalCard
        proposal={makeProposal({
          kind: 'CREATE_PART',
          targetType: 'PART',
          targetId: null,
          payload: {
            kind: 'CREATE_PART',
            name: { value: 'S14 string light bulbs', source: 'user' },
            partKind: { value: 'BULB', source: 'inferred' },
            typicalCost: { value: '4.50', source: 'user' },
            spec: { value: { base: 'E26', shape: 'S14', colorTempK: 2700 }, source: 'user' },
            itemId: 'item-1',
          },
        })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );

    expect(screen.getByText('New part')).toBeInTheDocument();
    // The part kind renders through the shared label map, not as the raw enum.
    expect(screen.getByText('Bulb')).toBeInTheDocument();
    expect(screen.getByText('$4.50')).toBeInTheDocument();
    expect(screen.getByText('BASE')).toBeInTheDocument();
    expect(screen.getByText('E26')).toBeInTheDocument();
    expect(screen.getByText('Color Temp K')).toBeInTheDocument();
  });

  it('pairs spec rows against the before-snapshot, which is keyed `spec`', () => {
    render(
      <ProposalCard
        proposal={makeProposal({
          kind: 'UPDATE_PART',
          targetType: 'PART',
          targetId: 'part-1',
          payload: {
            kind: 'UPDATE_PART',
            partId: 'part-1',
            typicalCost: { value: '4.50', source: 'user' },
            spec: { value: { merv: 13 }, source: 'user' },
          },
          baseUpdatedAt: new Date('2026-07-01T00:00:00Z'),
          // `typicalCost` is normalised to a fixed-2 string at capture: a
          // Decimal(10,2) holding 4.50 otherwise round-trips as "4.5" and shows
          // a spurious diff against a proposed "4.50".
          beforeSnapshot: { typicalCost: '4.50', spec: { merv: 11 } },
        })}
        applyProposal={noopApply}
        rejectProposal={noopApply}
        refreshProposal={noopRefresh}
      />,
    );

    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    // Unchanged cost renders identically on both sides — no phantom diff.
    expect(screen.getAllByText('$4.50')).toHaveLength(2);
  });
});
