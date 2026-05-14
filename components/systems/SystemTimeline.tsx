'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';

export type TimelineTargetChip = {
  kind: 'item' | 'system';
  id: string;
  name: string;
};

export type TimelineEvent = {
  id: string;
  type: 'service' | 'warranty' | 'reminder';
  date: Date;
  summary: string;
  href: string;
  targets: TimelineTargetChip[];
  /** Whether the event has at least one direct system target. */
  hasSystemTarget: boolean;
  /** Whether the event has at least one item-level target. */
  hasItemTarget: boolean;
};

type Filter = 'all' | 'system' | 'component';

type Props = { events: TimelineEvent[]; systemId: string };

const TYPE_LABELS: Record<TimelineEvent['type'], string> = {
  service: 'Service',
  warranty: 'Warranty',
  reminder: 'Reminder',
};

function formatTargetsLabel(targets: TimelineTargetChip[]): string {
  if (targets.length === 0) return '';
  const first = targets[0];
  if (targets.length === 1) {
    return first.kind === 'system' ? `${first.name} system` : first.name;
  }
  const others = targets.length - 1;
  const head = first.kind === 'system' ? `${first.name} system` : first.name;
  return `${head} + ${others} ${others === 1 ? 'other' : 'others'}`;
}

export function SystemTimeline({ events, systemId }: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return events;
    if (filter === 'system') return events.filter((e) => e.hasSystemTarget);
    return events.filter((e) => e.hasItemTarget);
  }, [events, filter]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">Timeline ({events.length})</CardTitle>
          <div className="flex flex-wrap gap-2" data-testid="timeline-add-event-group">
            <Button
              size="sm"
              variant="outline"
              render={<Link href={`/service/new?systemId=${systemId}`} />}
            >
              Add service record
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={<Link href={`/warranties/new?systemId=${systemId}`} />}
            >
              Add warranty
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={<Link href={`/reminders/new?systemId=${systemId}`} />}
            >
              Add reminder
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2" role="tablist" aria-label="Timeline filter">
          {(['all', 'system', 'component'] as const).map((f) => (
            <Button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              variant={filter === f ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(f)}
              data-testid={`timeline-filter-${f}`}
            >
              {f === 'all' ? 'All' : f === 'system' ? 'System-targeted' : 'Component-targeted'}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">no events to show.</p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((e) => (
              <li
                key={`${e.type}-${e.id}`}
                className="rounded-md border p-3"
                data-testid={`timeline-row-${e.type}-${e.id}`}
              >
                <Link href={e.href} className="block hover:bg-muted/40 -m-3 p-3 rounded-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{TYPE_LABELS[e.type]}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatCalendarDate(e.date)}
                        </span>
                      </div>
                      <span className="text-sm font-medium">{e.summary}</span>
                      {e.targets.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {formatTargetsLabel(e.targets)}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
