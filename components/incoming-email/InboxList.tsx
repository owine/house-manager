import { FileSearch, Inbox as InboxIcon, Mail, Paperclip, Receipt, Wrench } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { LocalDate } from '@/components/ui/LocalDate';
import type { InboxRow } from '@/lib/incoming-email/queries';

const KIND_ICON = {
  ESTIMATE: FileSearch,
  INVOICE: Receipt,
  TICKET: Wrench,
  UNKNOWN: Mail,
} as const;

function KindIcon({ kind }: { kind: InboxRow['kind'] }) {
  const Icon = KIND_ICON[kind];
  return (
    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={kind.toLowerCase()} />
  );
}

export function InboxList({ rows }: { rows: InboxRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        <InboxIcon className="h-8 w-8" />
        <p className="text-sm">No emails to triage.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={`/inbox/${row.id}`}
            className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 sm:items-center"
          >
            <KindIcon kind={row.kind} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">
                  {row.subject || '(no subject)'}
                </span>
                {row.state === 'AUTO_LINKED' && (
                  <Badge variant="secondary" className="shrink-0">
                    Auto-linked
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate">
                  {row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress}
                </span>
                <span aria-hidden="true">·</span>
                <LocalDate iso={row.receivedAt.toISOString()} />
                {row.attachmentCount > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <Paperclip className="h-3 w-3" /> {row.attachmentCount}
                  </span>
                )}
                {row.hasVendor && <Badge variant="outline">Vendor</Badge>}
                {row.itemTargetCount > 0 && (
                  <Badge variant="outline">
                    {row.itemTargetCount === 1 ? 'Item' : `${row.itemTargetCount} items`}
                  </Badge>
                )}
                {row.systemTargetCount > 0 && (
                  <Badge variant="outline">
                    {row.systemTargetCount === 1 ? 'System' : `${row.systemTargetCount} systems`}
                  </Badge>
                )}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
