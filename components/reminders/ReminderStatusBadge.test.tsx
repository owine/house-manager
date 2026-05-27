// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReminderStatusBadge } from './ReminderStatusBadge';

afterEach(cleanup);

describe('ReminderStatusBadge', () => {
  it('renders Due today (not Overdue) when due is today in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const due = new Date('2026-05-27T00:00:00Z');
    render(<ReminderStatusBadge nextDueOn={due} active={true} tz="UTC" now={now} />);
    const badge = screen.getByTestId('reminder-due-badge');
    expect(badge).not.toHaveTextContent('Overdue');
    expect(badge).toHaveTextContent('Due today');
  });

  it('renders Overdue when due is yesterday in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const due = new Date('2026-05-26T00:00:00Z');
    render(<ReminderStatusBadge nextDueOn={due} active={true} tz="UTC" now={now} />);
    expect(screen.getByTestId('reminder-due-badge')).toHaveTextContent('Overdue');
  });
});
