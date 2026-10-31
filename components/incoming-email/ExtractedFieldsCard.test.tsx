// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { asCalendarDate } from '@/lib/time/tz';
import { ExtractedFieldsCard } from './ExtractedFieldsCard';

afterEach(cleanup);

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
