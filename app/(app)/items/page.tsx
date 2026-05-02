import { Plus } from 'lucide-react';
import Link from 'next/link';

import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ItemCardGrid } from '@/components/items/ItemCardGrid';
import { ItemsFilterBar } from '@/components/items/ItemsFilterBar';
import { Button } from '@/components/ui/button';
import { listAllCategories, listAllItemLocations, listItems } from '@/lib/items/queries';
import { parseListParams } from '@/lib/url-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ItemsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v);
  }

  const params = parseListParams(sp);
  const [{ items, total }, categories, locations] = await Promise.all([
    listItems(params),
    listAllCategories(),
    listAllItemLocations(),
  ]);

  const noItemsAtAll = items.length === 0 && !params.q && !Object.keys(params.filters).length;

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`Items (${total})`}
          description="Appliances, tools, and other house items."
          actions={
            <Button render={<Link href="/items/new" />}>
              <Plus className="h-4 w-4" />
              New item
            </Button>
          }
        />
      }
      filters={
        <ItemsFilterBar
          q={params.q ?? ''}
          selectedCategorySlug={params.filters.category?.[0] ?? ''}
          selectedLocation={params.filters.location?.[0] ?? ''}
          showArchived={params.filters.archived?.includes('true') ?? false}
          initialView={null}
          categories={categories}
          locations={locations}
        />
      }
      isEmpty={items.length === 0}
      empty={
        noItemsAtAll ? (
          <EmptyState
            message="No items yet."
            action={<Button render={<Link href="/items/new" />}>Add your first item</Button>}
          />
        ) : (
          <EmptyState
            message="No items match your filters."
            action={
              <Button variant="ghost" render={<Link href="/items" />}>
                Clear filters
              </Button>
            }
          />
        )
      }
    >
      <ItemCardGrid items={items} />
    </ListPageShell>
  );
}
