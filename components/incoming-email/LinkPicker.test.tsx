// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LinkPicker } from './LinkPicker';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/incoming-email/actions', () => ({
  archiveIncomingEmail: vi.fn(),
  attachIncomingEmail: vi.fn(async () => ({ ok: true, data: { id: 'e1' } })),
  createServiceRecordFromEmail: vi.fn(),
  reclassifyIncomingEmail: vi.fn(),
  unarchiveIncomingEmail: vi.fn(),
}));

afterEach(cleanup);

const items = [{ id: 'i1', name: 'Furnace', categoryName: 'HVAC', archivedAt: null }];
const systems = [
  { id: 's1', name: 'HVAC', kind: 'hvac', items: [] as Array<{ id: string; archivedAt: null }> },
];

describe('LinkPicker', () => {
  // `incoming_email_targets` has no partId column and keeps a two-way XOR
  // CHECK. A part target emitted here would be rejected by the database — a
  // 500, not a form error. The picker must never offer one.
  it('offers no Parts section', async () => {
    const user = userEvent.setup();
    render(
      <LinkPicker
        emailId="e1"
        initialVendorId={null}
        initialTargets={[]}
        vendors={[]}
        items={items}
        systems={systems}
      />,
    );
    await user.click(screen.getByRole('button', { name: /select items \/ systems/i }));
    // The picker is now mounted inside the popover…
    expect(screen.getByRole('button', { name: /^Items/ })).toBeInTheDocument();
    // …and carries no Parts affordance.
    expect(screen.queryByRole('button', { name: /^Parts/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('targets-picker-parts-list')).not.toBeInTheDocument();
  });
});
