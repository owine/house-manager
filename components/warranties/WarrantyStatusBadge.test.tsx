// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type CalendarDate, calendarDate } from '@/lib/time/tz';
import { WarrantyStatusBadge } from './WarrantyStatusBadge';

afterEach(cleanup);

const cal = (y: number, m: number, d: number): CalendarDate => calendarDate(y, m, d);

describe('WarrantyStatusBadge', () => {
  // `endsOn` is a calendar date at UTC midnight, and coverage is INCLUSIVE of
  // that day. Comparing it against a raw instant (`endsOn - Date.now()`) made it
  // go negative the moment UTC ticked over -- 7:00 PM Chicago the evening BEFORE
  // the end date -- so the badge read "Expired" through the whole final covered
  // day.
  const TZ = 'America/Chicago';
  const ENDS = cal(2026, 7, 14);

  it.each([
    ['2026-07-13T22:00:00Z', 'Expiring soon', '17:00 CDT Jul 13, day before'],
    ['2026-07-14T16:00:00Z', 'Expiring soon', '11:00 CDT Jul 14, the end date itself'],
    ['2026-07-15T01:00:00Z', 'Expiring soon', '20:00 CDT Jul 14, last covered evening'],
    ['2026-07-15T16:00:00Z', 'Expired', '11:00 CDT Jul 15, genuinely over'],
  ])('at %s renders "%s" (%s)', (iso, expected) => {
    render(<WarrantyStatusBadge endsOn={ENDS} tz={TZ} now={new Date(iso)} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders Active when the end date is far out', () => {
    render(
      <WarrantyStatusBadge
        endsOn={cal(2027, 7, 14)}
        tz={TZ}
        now={new Date('2026-07-14T16:00:00Z')}
      />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
