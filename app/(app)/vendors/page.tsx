import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
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
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Vendors ({total})</h1>
        <Link href="/vendors/new">+ Add vendor</Link>
      </header>
      {vendors.length === 0 ? (
        <EmptyState
          message="No vendors yet."
          action={<Link href="/vendors/new">Add your first vendor</Link>}
        />
      ) : (
        <VendorTable vendors={vendors} />
      )}
    </div>
  );
}
