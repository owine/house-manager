import { Plus } from 'lucide-react';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listChecklists } from '@/lib/checklists/queries';

export default async function ChecklistsPage() {
  const checklists = await listChecklists();
  const isEmpty = checklists.length === 0;

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`Checklists (${checklists.length})`}
          actions={
            <Button render={<Link href="/checklists/new" />}>
              <Plus className="h-4 w-4" />
              New checklist
            </Button>
          }
        />
      }
      isEmpty={isEmpty}
      empty={
        <EmptyState
          title="No checklists yet"
          description="Create one manually, or generate one from the dashboard."
          action={
            <Button render={<Link href="/checklists/new" />}>
              <Plus className="h-4 w-4" />
              New checklist
            </Button>
          }
        />
      }
    >
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {checklists.map((c) => (
          <li key={c.id}>
            <Link href={`/checklists/${c.id}`} className="block">
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <CardTitle>{c.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {c._count.items} {c._count.items === 1 ? 'item' : 'items'}
                  </p>
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </ListPageShell>
  );
}
