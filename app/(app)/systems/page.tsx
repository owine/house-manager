import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCalendarDate } from '@/lib/format/date';
import { listSystems } from '@/lib/systems/queries';

export const metadata: Metadata = { title: 'systems' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SystemsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const showArchived = sp.archived === 'true';

  const systems = await listSystems({ archived: showArchived });
  const visible = showArchived
    ? systems.filter((s) => s.archivedAt !== null)
    : systems.filter((s) => s.archivedAt === null);

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`systems (${visible.length})`}
          description="Group items into logical systems — HVAC, plumbing, electrical, etc."
          actions={
            <Button render={<Link href="/systems/new" />}>
              <Plus className="h-4 w-4" />
              New system
            </Button>
          }
        />
      }
      filters={
        <div className="flex gap-2">
          <Button
            variant={showArchived ? 'outline' : 'default'}
            size="sm"
            render={<Link href="/systems" />}
          >
            Active
          </Button>
          <Button
            variant={showArchived ? 'default' : 'outline'}
            size="sm"
            render={<Link href="/systems?archived=true" />}
          >
            Archived
          </Button>
        </div>
      }
      isEmpty={visible.length === 0}
      empty={
        <EmptyState
          title={showArchived ? 'No archived systems.' : 'No systems yet.'}
          description={
            showArchived
              ? undefined
              : 'A system groups related items: e.g. an HVAC system bundles the furnace, AC unit, thermostat, and ductwork so you can track shared install costs and warranties in one place.'
          }
          action={
            !showArchived ? (
              <Button render={<Link href="/systems/new" />}>Create your first system</Button>
            ) : undefined
          }
        />
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {visible.map((s) => (
          <Card key={s.id} className="flex flex-col">
            <CardHeader>
              <CardTitle>
                <Link href={`/systems/${s.id}`} className="hover:underline">
                  {s.name}
                </Link>
              </CardTitle>
              <div className="flex flex-wrap gap-1.5">
                {s.kind && <Badge variant="secondary">{s.kind}</Badge>}
                {s.archivedAt && <Badge variant="destructive">Archived</Badge>}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
              {s.location && <span>{s.location}</span>}
              {s.installDate && (
                <span className="text-xs">Installed: {formatCalendarDate(s.installDate)}</span>
              )}
            </CardContent>
            <CardFooter className="mt-auto text-xs text-muted-foreground">
              {s._count.items} components
            </CardFooter>
          </Card>
        ))}
      </div>
    </ListPageShell>
  );
}
