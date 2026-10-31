// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { ExtractedFieldsCard } from './ExtractedFieldsCard';

afterEach(cleanup);

// Pin a zone west of UTC rather than trust the runner's. In UTC, a renderer that
// formats in local time shows the right day too, and this test would prove nothing.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('ExtractedFieldsCard', () => {
  it('shows the extracted service date as that calendar day in any viewer timezone', () => {
    // Stored at UTC midnight. Rendered in a US browser's timezone it was Apr 14.
    render(
      <ExtractedFieldsCard
        extraction={{
          summary: null,
          cost: null,
          performedOn: asCalendarDate(new Date('2026-04-15T00:00:00Z')),
          scope: null,
          extractedAt: null,
        }}
      />,
    );
    expect(screen.getByText('Apr 15, 2026')).toBeInTheDocument();
  });
});
