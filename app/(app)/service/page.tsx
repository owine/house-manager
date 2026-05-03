import { Plus } from 'lucide-react';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';
import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ServiceRecordFilterBar } from '@/components/service-records/ServiceRecordFilterBar';
import { ServiceRecordTable } from '@/components/service-records/ServiceRecordTable';
import { Button } from '@/components/ui/button';
import { listItems } from '@/lib/items/queries';
import { listServiceRecords } from '@/lib/service-records/queries';
import { parseListParams } from '@/lib/url-params';
import { listVendors } from '@/lib/vendors/queries';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ServicePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v);
  }

  const params = parseListParams(sp);
  const [{ records, total }, { items }, { vendors }] = await Promise.all([
    listServiceRecords(params),
    listItems({ page: 1, pageSize: 200, filters: {} }),
    listVendors({ page: 1, pageSize: 200, filters: {} }),
  ]);

  const hasFilters = !!params.q || Object.keys(params.filters).length > 0;
  const isEmpty = records.length === 0 && !hasFilters;

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`Service records (${total})`}
          actions={
            <Button render={<Link href="/service/new" />}>
              <Plus className="h-4 w-4" />
              Log service
            </Button>
          }
        />
      }
      filters={
        <ServiceRecordFilterBar
          q={params.q ?? ''}
          selectedItemId={params.filters.itemId?.[0] ?? ''}
          selectedVendorId={params.filters.vendorId?.[0] ?? ''}
          from={params.filters.from?.[0] ?? ''}
          to={params.filters.to?.[0] ?? ''}
          items={items}
          vendors={vendors}
        />
      }
      isEmpty={records.length === 0}
      empty={
        isEmpty ? (
          <EmptyState
            message="No service records yet."
            action={<Button render={<Link href="/service/new" />}>Log first service</Button>}
          />
        ) : (
          <EmptyState
            message="No records match your filters."
            action={
              <Button variant="ghost" render={<Link href="/service" />}>
                Clear filters
              </Button>
            }
          />
        )
      }
    >
      <ServiceRecordTable records={records} />
    </ListPageShell>
  );
}
