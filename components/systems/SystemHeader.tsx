'use client';

import { Archive, ArchiveRestore, PencilLine } from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LocalDate } from '@/components/ui/LocalDate';
import { formatCalendarDate } from '@/lib/format/date';

type SystemHeaderSystem = {
  id: string;
  name: string;
  kind: string | null;
  location: string | null;
  installDate: Date | null;
  archivedAt: Date | null;
};

type Props = {
  system: SystemHeaderSystem;
  onArchive: () => Promise<{ ok: boolean; formError?: string }>;
  onUnarchive: () => Promise<{ ok: boolean; formError?: string }>;
};

export function SystemHeader({ system, onArchive, onUnarchive }: Props) {
  const [pending, startTransition] = useTransition();
  const isArchived = system.archivedAt !== null;

  function handleArchiveToggle() {
    startTransition(async () => {
      const r = isArchived ? await onUnarchive() : await onArchive();
      if (!r.ok) {
        toast.error(r.formError ?? 'Failed to update system');
        return;
      }
      toast.success(isArchived ? 'System restored' : 'System archived');
    });
  }

  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{system.name}</h1>
          {system.kind && <Badge variant="secondary">{system.kind}</Badge>}
          {isArchived && (
            <Badge variant="destructive">
              Archived <LocalDate iso={system.archivedAt?.toISOString() ?? ''} />
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {system.location && <span>{system.location}</span>}
          {system.location && system.installDate && <span> · </span>}
          {system.installDate && <span>Installed {formatCalendarDate(system.installDate)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" render={<Link href={`/systems/${system.id}/edit`} />}>
          <PencilLine className="h-4 w-4" />
          Edit
        </Button>
        <Button
          variant={isArchived ? 'outline' : 'destructive'}
          onClick={handleArchiveToggle}
          disabled={pending}
        >
          {isArchived ? (
            <>
              <ArchiveRestore className="h-4 w-4" />
              Restore
            </>
          ) : (
            <>
              <Archive className="h-4 w-4" />
              Archive
            </>
          )}
        </Button>
      </div>
    </header>
  );
}

export default SystemHeader;
