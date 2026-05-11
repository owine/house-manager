import { ChevronLeft, ChevronRight, List } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { MonthGrid } from '@/components/calendar/MonthGrid';
import { Button } from '@/components/ui/button';
import { listCalendarEventsInRange } from '@/lib/calendar/queries';

export const metadata: Metadata = { title: 'Reminders calendar' };

type SearchParams = Promise<{ month?: string }>;

/**
 * Parse a `YYYY-MM` query param into a UTC-anchored month start. Falls back
 * to the current month when missing or malformed so the page is always
 * useful even after a typo in the URL.
 */
function parseMonth(raw: string | undefined): Date {
  const today = new Date();
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) {
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  }
  const [yearStr, monthStr] = raw.split('-');
  const year = Number(yearStr);
  const monthIdx = Number(monthStr) - 1;
  if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11) {
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  }
  return new Date(Date.UTC(year, monthIdx, 1));
}

function isoMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthName(d: Date): string {
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const { month } = await searchParams;
  const monthStart = parseMonth(month);
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const prev = new Date(monthStart);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const next = new Date(monthStart);
  next.setUTCMonth(next.getUTCMonth() + 1);

  const events = await listCalendarEventsInRange({ start: monthStart, end: monthEnd });

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);

  return (
    <ListPageShell
      header={
        <PageHeader
          title={monthName(monthStart)}
          description={`${events.length} ${events.length === 1 ? 'event' : 'events'} this month`}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                render={<Link href={`/reminders/calendar?month=${isoMonth(prev)}`} />}
                aria-label="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" render={<Link href="/reminders/calendar" />}>
                Today
              </Button>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={`/reminders/calendar?month=${isoMonth(next)}`} />}
                aria-label="Next month"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" render={<Link href="/reminders" />}>
                <List className="h-4 w-4" />
                List
              </Button>
            </div>
          }
        />
      }
      isEmpty={false}
      empty={null}
    >
      <MonthGrid monthStart={monthStart} events={events} todayIso={todayIso} />
      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm bg-primary/30" /> Reminder due
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm bg-green-600/30" /> Service performed
        </span>
      </div>
    </ListPageShell>
  );
}
