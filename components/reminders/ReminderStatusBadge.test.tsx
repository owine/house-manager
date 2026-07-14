// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { asCalendarDate, type CalendarDate, calendarDate } from '@/lib/time/tz';
import { ReminderStatusBadge } from './ReminderStatusBadge';

afterEach(cleanup);

describe('ReminderStatusBadge', () => {
  it('renders Due today (not Overdue) when due is today in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const due = asCalendarDate(new Date('2026-05-27T00:00:00Z'));
    render(<ReminderStatusBadge nextDueOn={due} active={true} tz="UTC" now={now} />);
    const badge = screen.getByTestId('reminder-due-badge');
    expect(badge).not.toHaveTextContent('Overdue');
    expect(badge).toHaveTextContent('Due today');
  });

  it('renders Overdue when due is yesterday in tz', () => {
    const now = new Date('2026-05-27T15:00:00Z');
    const due = asCalendarDate(new Date('2026-05-26T00:00:00Z'));
    render(<ReminderStatusBadge nextDueOn={due} active={true} tz="UTC" now={now} />);
    expect(screen.getByTestId('reminder-due-badge')).toHaveTextContent('Overdue');
  });

  // Both cases above pass tz="UTC" -- the one timezone in which reading a
  // calendar date *through* the timezone happens to be a no-op. That is why the
  // bug below survived. `nextDueOn` is a calendar date at UTC midnight, so in a
  // negative-offset zone it lands on the PREVIOUS day and every countdown slid
  // back by one.
  describe('in the house timezone (America/Chicago, UTC-5)', () => {
    const cal = (y: number, m: number, d: number): CalendarDate => calendarDate(y, m, d);
    const badge = () => screen.getByTestId('reminder-due-badge');
    const TZ = 'America/Chicago';
    const NOW = new Date('2026-07-14T16:00:00Z'); // 11:00 CDT, Tue Jul 14

    it.each([
      [cal(2026, 7, 14), 'Due today'],
      [cal(2026, 7, 15), 'Due soon'],
      [cal(2026, 7, 20), 'In 6d'],
    ])('due %s renders "%s"', (nextDueOn, expected) => {
      render(<ReminderStatusBadge nextDueOn={nextDueOn} active={true} tz={TZ} now={NOW} />);
      expect(badge()).toHaveTextContent(expected);
    });

    it('does not roll over to tomorrow at the UTC day boundary', () => {
      // 20:00 CDT on Jul 14: the UTC date has already ticked to Jul 15, but the
      // house day has not. "Today" must still be Jul 14.
      const evening = new Date('2026-07-15T01:00:00Z');
      render(
        <ReminderStatusBadge nextDueOn={cal(2026, 7, 14)} active={true} tz={TZ} now={evening} />,
      );
      expect(badge()).toHaveTextContent('Due today');
      expect(badge()).not.toHaveTextContent('Overdue');
    });

    it('still flags a genuinely past date as Overdue', () => {
      render(<ReminderStatusBadge nextDueOn={cal(2026, 7, 13)} active={true} tz={TZ} now={NOW} />);
      expect(badge()).toHaveTextContent('Overdue');
    });
  });
});
