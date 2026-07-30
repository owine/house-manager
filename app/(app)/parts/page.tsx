import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { PartsFilterBar } from '@/components/parts/PartsFilterBar';
import { PartTable } from '@/components/parts/PartTable';
import { Button } from '@/components/ui/button';
import { listAllActiveItemsForPicker } from '@/lib/items/queries';
import { listParts } from '@/lib/parts/queries';
import { listSystemsForPicker } from '@/lib/systems/queries';
import { parseListParams } from '@/lib/url-params';

export const metadata: Metadata = { title: 'parts' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PartsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v);
  }

  const params = parseListParams(sp);
  const [{ parts, total }, items, systems] = await Promise.all([
    listParts(params),
    listAllActiveItemsForPicker(),
    listSystemsForPicker(),
  ]);

  const noPartsAtAll = parts.length === 0 && !params.q && !Object.keys(params.filters).length;

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`parts (${total})`}
          description="Bulbs, filters, batteries, belts and other re-buys."
          actions={
            <Button render={<Link href="/parts/new" />}>
              <Plus className="h-4 w-4" />
              New part
            </Button>
          }
        />
      }
      filters={
        <PartsFilterBar
          q={params.q ?? ''}
          selectedKind={params.filters.kind?.[0] ?? ''}
          selectedItemId={params.filters.item?.[0] ?? ''}
          selectedSystemId={params.filters.system?.[0] ?? ''}
          showArchived={params.filters.archived?.includes('true') ?? false}
          items={items.map((i) => ({ id: i.id, name: i.name }))}
          systems={systems}
        />
      }
      isEmpty={parts.length === 0}
      empty={
        noPartsAtAll ? (
          <EmptyState
            title="no parts yet."
            description="Track the consumables you re-buy: bulbs, filters, batteries, salt."
            action={<Button render={<Link href="/parts/new" />}>add your first part</Button>}
          />
        ) : (
          <EmptyState
            title="no parts match your filters."
            action={
              <Button variant="ghost" render={<Link href="/parts" />}>
                Clear filters
              </Button>
            }
          />
        )
      }
    >
      <PartTable parts={parts} />
    </ListPageShell>
  );
}
