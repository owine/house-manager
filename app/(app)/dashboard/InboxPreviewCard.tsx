import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import type { InboxRow } from '@/lib/incoming-email/queries';

type Props = { emails: InboxRow[] };

/**
 * Dashboard widget: shows up to 5 untriaged incoming emails so the user
 * sees inbound vendor messages without leaving the dashboard. Hidden when
 * the untriaged queue is empty — no point of yet another empty-state card.
 *
 * Each row links into the inbox detail page; the sidebar already carries
 * the unread count via the `inbox` badge.
 */
export function InboxPreviewCard({ emails }: Props) {
  if (emails.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          Untriaged inbox
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {emails.map((e) => (
            <li key={e.id} className="py-2 first:pt-0 last:pb-0">
              <Link
                href={`/inbox/${e.id}`}
                className="flex flex-col gap-0.5 rounded-md p-1 hover:bg-muted/50 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.subject}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {e.fromName ?? e.fromAddress}
                    {e.kind !== 'UNKNOWN' && <> · {e.kind.toLowerCase()}</>}
                  </p>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                  {formatCalendarDate(e.receivedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-xs">
          <Link href="/inbox" className="text-muted-foreground hover:underline">
            See all →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
