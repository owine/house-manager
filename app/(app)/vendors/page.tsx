import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPageShell } from '@/app/(app)/_components/ListPageShell';

export const metadata: Metadata = { title: 'vendors' };

import { PageHeader } from '@/app/(app)/_components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { VendorTable } from '@/components/vendors/VendorTable';
import { parseListParams } from '@/lib/url-params';
import { listVendors } from '@/lib/vendors/queries';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function VendorsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v);
  }
  const params = parseListParams(sp);
  const { vendors, total } = await listVendors(params);

  return (
    <ListPageShell
      header={
        <PageHeader
          title={`vendors (${total})`}
          actions={
            <Button render={<Link href="/vendors/new" />}>
              <Plus className="h-4 w-4" />
              Add vendor
            </Button>
          }
        />
      }
      isEmpty={vendors.length === 0}
      empty={
        <EmptyState
          title="no vendors yet."
          action={<Button render={<Link href="/vendors/new" />}>add your first vendor</Button>}
        />
      }
    >
      <VendorTable vendors={vendors} />
    </ListPageShell>
  );
}
