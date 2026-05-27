// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';
import { CompletionRow } from './CompletionRow';

afterEach(cleanup);

const baseProps = {
  id: 'comp-1',
  completedOn: new Date('2026-05-27T00:00:00Z'),
  completedBy: { name: 'Alice' },
  notes: null,
};

describe('CompletionRow', () => {
  it('shows "Auto" badge when completedById is SYSTEM_AUTO_COMPLETE_USER_ID', () => {
    render(<CompletionRow {...baseProps} completedById={SYSTEM_AUTO_COMPLETE_USER_ID} />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('does not show "Auto" badge for a regular user completion', () => {
    render(<CompletionRow {...baseProps} completedById="user-123" />);
    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
  });

  it('renders the completedBy name', () => {
    render(<CompletionRow {...baseProps} completedById="user-123" />);
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('renders notes when provided', () => {
    render(<CompletionRow {...baseProps} completedById="user-123" notes="looked great" />);
    expect(screen.getByText(/looked great/)).toBeInTheDocument();
  });

  it('does not render notes section when notes is null', () => {
    render(<CompletionRow {...baseProps} completedById="user-123" notes={null} />);
    expect(screen.queryByText(/:/)).not.toBeInTheDocument();
  });
});
