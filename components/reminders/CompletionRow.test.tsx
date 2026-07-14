// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_AUTO_COMPLETE_USER_ID } from '@/lib/reminders/system-user';
import { CompletionRow } from './CompletionRow';

afterEach(cleanup);

const baseProps = {
  completedOn: new Date('2026-05-27T00:00:00Z'),
  completedBy: { name: 'Alice' },
  notes: null,
  tz: 'America/Chicago',
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

  // `completedOn` is an INSTANT. It was rendered with formatCalendarDate, which
  // formats in UTC -- so any completion after 7pm Chicago showed tomorrow's date.
  it('dates an evening completion by the house day, not the UTC day', () => {
    render(
      <CompletionRow
        {...baseProps}
        completedOn={new Date('2026-07-15T01:00:00Z')} // 20:00 CDT on Jul 14
        completedById="user-123"
      />,
    );
    expect(screen.getByText(/Jul 14, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Jul 15, 2026/)).not.toBeInTheDocument();
  });

  it('dates an auto-completed chore by the day it was actually due', () => {
    // chore-auto-complete stamps completedOn = endOfCalendarDayInTz(dueOn, tz) =
    // 04:59:59.999Z the NEXT UTC day, so in UTC this read a day late for EVERY
    // auto-completed chore, systematically.
    render(
      <CompletionRow
        {...baseProps}
        completedOn={new Date('2026-07-15T04:59:59.999Z')} // chore due Jul 14
        completedById={SYSTEM_AUTO_COMPLETE_USER_ID}
      />,
    );
    expect(screen.getByText(/Jul 14, 2026/)).toBeInTheDocument();
  });
});
