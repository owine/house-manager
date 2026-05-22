import Link from 'next/link';
import type { CalendarEvent } from '@/lib/calendar/queries';

type Props = {
  /** First day of the month being rendered (anchored to UTC midnight). */
  monthStart: Date;
  events: CalendarEvent[];
  /** ISO YYYY-MM-DD for "today" — highlighted with a ring. */
  todayIso: string;
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hrefFor(event: CalendarEvent): string {
  return event.kind === 'reminder' ? `/reminders/${event.id}` : `/service/${event.id}`;
}

/**
 * Renders a 7-column monthly calendar grid with day cells. Each day lists up
 * to 3 events as colored chips (blue=reminder, green=service). Past days
 * render slightly muted; today gets a primary-color ring.
 *
 * Pure server component — `Link` keeps navigation client-side; no other
 * client state.
 */
export function MonthGrid({ monthStart, events, todayIso }: Props) {
  // Build the cells: leading blanks for the first row, then every day of
  // the month, then trailing blanks so the grid is rectangular.
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDayOfWeek = monthStart.getUTCDay();

  // Each cell carries a stable key — blank leading/trailing cells get a
  // synthetic `blank-<position>` so React doesn't fall back to using the
  // array index as the key.
  type Cell = { key: string; iso: string | null; day: number | null };
  const cells: Cell[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push({ key: `lead-${i}`, iso: null, day: null });
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(Date.UTC(year, month, day));
    cells.push({ key: toIsoDate(date), iso: toIsoDate(date), day });
  }
  let trailingIdx = 0;
  while (cells.length % 7 !== 0) {
    cells.push({ key: `trail-${trailingIdx++}`, iso: null, day: null });
  }

  // Bucket events by ISO date for O(1) lookup per cell.
  const byDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = toIsoDate(ev.date);
    const list = byDay.get(key) ?? [];
    list.push(ev);
    byDay.set(key, list);
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="px-1 py-1">
            {w}
          </div>
        ))}
      </div>
      <div
        className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border"
        data-testid="calendar-grid"
      >
        {cells.map((cell) => {
          if (cell.iso === null) {
            return <div key={cell.key} className="min-h-24 bg-background" />;
          }
          const isToday = cell.iso === todayIso;
          const isPast = cell.iso < todayIso;
          const dayEvents = byDay.get(cell.iso) ?? [];
          return (
            <div
              key={cell.key}
              className={`flex min-h-24 flex-col gap-1 bg-background p-1.5 ${isToday ? 'ring-2 ring-primary ring-inset' : ''} ${isPast ? 'opacity-80' : ''}`}
            >
              <div className="text-xs font-medium">{cell.day}</div>
              <ul className="space-y-0.5">
                {dayEvents.slice(0, 3).map((ev) => (
                  <li key={`${ev.kind}:${ev.id}`}>
                    <Link
                      href={hrefFor(ev)}
                      title={ev.title}
                      className={`block truncate rounded-sm px-1 py-0.5 text-[10px] hover:underline ${
                        ev.kind === 'reminder'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-green-600/10 text-green-700 dark:text-green-400'
                      }`}
                    >
                      {ev.title}
                    </Link>
                  </li>
                ))}
                {dayEvents.length > 3 && (
                  <li className="px-1 text-[10px] text-muted-foreground">
                    +{dayEvents.length - 3} more
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
