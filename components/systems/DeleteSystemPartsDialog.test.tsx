// @vitest-environment jsdom
//
// The default-checked rule is the whole point of this dialog: a part linked to
// two other fixtures must NOT be archived because one parent was deleted.
// These tests assert on the SUBMITTED payload, not on rendered checkbox state,
// so a default that renders right but submits wrong still fails.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemPartSummary } from '@/lib/systems/actions';
import { DeleteSystemPartsDialog, defaultCheckedPartIds } from './DeleteSystemPartsDialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
});

const PARTS: SystemPartSummary[] = [
  { id: 'orphan', name: 'Furnace filter', kind: 'AIR_FILTER', willBeOrphaned: true },
  { id: 'shared', name: 'BR30 bulb', kind: 'BULB', willBeOrphaned: false },
];

describe('defaultCheckedPartIds', () => {
  it('checks only the parts that would be orphaned', () => {
    expect(defaultCheckedPartIds(PARTS)).toEqual(['orphan']);
  });

  it('checks nothing when every part is still linked elsewhere', () => {
    expect(defaultCheckedPartIds([PARTS[1]])).toEqual([]);
  });
});

describe('DeleteSystemPartsDialog', () => {
  it('submits only the orphaned part as archived, the rest as kept', async () => {
    const onConfirm = vi.fn(async () => ({
      ok: true as const,
      archivedCount: 1,
      keptCount: 1,
    }));
    render(
      <DeleteSystemPartsDialog
        open
        onOpenChange={() => {}}
        systemName="HVAC"
        parts={PARTS}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByTestId('delete-system-confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      archivePartIds: ['orphan'],
      keepPartIds: ['shared'],
    });
  });

  it('lets the user check a still-linked part via its label', async () => {
    const onConfirm = vi.fn(
      async (_input: { archivePartIds: string[]; keepPartIds: string[] }) => ({
        ok: true as const,
        archivedCount: 2,
        keptCount: 0,
      }),
    );
    render(
      <DeleteSystemPartsDialog
        open
        onOpenChange={() => {}}
        systemName="HVAC"
        parts={PARTS}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByText('BR30 bulb'));
    await userEvent.click(screen.getByTestId('delete-system-confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0]).toEqual({
      archivePartIds: ['orphan', 'shared'],
      keepPartIds: [],
    });
  });

  it('re-renders against the fresh list when the server reports a stale prompt', async () => {
    const fresh: SystemPartSummary[] = [
      ...PARTS,
      { id: 'late', name: 'Belt', kind: 'BELT', willBeOrphaned: true },
    ];
    const onConfirm = vi
      .fn<
        (input: {
          archivePartIds: string[];
          keepPartIds: string[];
        }) => Promise<
          | { ok: true; archivedCount: number; keptCount: number }
          | { ok: false; hasParts: true; parts: SystemPartSummary[] }
        >
      >()
      .mockResolvedValueOnce({ ok: false, hasParts: true, parts: fresh })
      .mockResolvedValue({ ok: true, archivedCount: 2, keptCount: 1 });

    render(
      <DeleteSystemPartsDialog
        open
        onOpenChange={() => {}}
        systemName="HVAC"
        parts={PARTS}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByTestId('delete-system-confirm'));
    // The part that appeared under us is now on screen, default-checked
    // because it too would be orphaned.
    await waitFor(() => expect(screen.getByText('Belt')).toBeInTheDocument());

    // Belt being on screen does NOT mean the button is clickable again. The
    // fresh rows and the re-enable are two separate signals from the same
    // transition — `setRows` commits the list, `useTransition`'s isPending
    // clears the `disabled` — and React does not guarantee they land in the
    // same commit. A click that arrives while `disabled` is still true is
    // dropped silently: userEvent does not throw, so the only evidence is a
    // second call that never happens. Wait on the gate itself.
    await waitFor(() => expect(screen.getByTestId('delete-system-confirm')).toBeEnabled());

    await userEvent.click(screen.getByTestId('delete-system-confirm'));
    // And wait for the call before reading it, as the two tests above do.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toEqual({
      archivePartIds: ['orphan', 'late'],
      keepPartIds: ['shared'],
    });
  });

  // The invariant that made the test above flaky is itself worth asserting:
  // the confirm button is the double-submit guard, and a click landing while a
  // confirm is in flight must not produce a second server call.
  it('does not fire a second confirm while the first is still in flight', async () => {
    const onConfirm = vi.fn(() => new Promise<never>(() => {})); // never settles
    render(
      <DeleteSystemPartsDialog
        open
        onOpenChange={() => {}}
        systemName="HVAC"
        parts={PARTS}
        onConfirm={onConfirm as never}
      />,
    );

    const confirm = screen.getByTestId('delete-system-confirm');
    await userEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirm).toBeDisabled();

    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
