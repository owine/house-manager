import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { ServiceRecordTable } from '@/components/service-records/ServiceRecordTable';
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
    <div>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
        }}
      >
        <h1>Service records ({total})</h1>
        <Link href="/service/new">+ Log service</Link>
      </header>

      {/* Filter form */}
      <form
        method="get"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          alignItems: 'flex-end',
        }}
      >
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Search
          <input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Search summary…"
            style={{ padding: '0.3rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Item
          <select
            name="itemId"
            defaultValue={params.filters.itemId?.[0] ?? ''}
            style={{ padding: '0.3rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
          >
            <option value="">All items</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Vendor
          <select
            name="vendorId"
            defaultValue={params.filters.vendorId?.[0] ?? ''}
            style={{ padding: '0.3rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
          >
            <option value="">All vendors</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          From
          <input
            type="date"
            name="from"
            defaultValue={params.filters.from?.[0] ?? ''}
            style={{ padding: '0.3rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          To
          <input
            type="date"
            name="to"
            defaultValue={params.filters.to?.[0] ?? ''}
            style={{ padding: '0.3rem 0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </label>

        <button
          type="submit"
          style={{
            padding: '0.3rem 0.75rem',
            borderRadius: '4px',
            border: '1px solid #ccc',
            cursor: 'pointer',
          }}
        >
          Filter
        </button>

        {hasFilters && (
          <Link
            href="/service"
            style={{ padding: '0.3rem 0.75rem', fontSize: '0.85rem', alignSelf: 'flex-end' }}
          >
            Clear
          </Link>
        )}
      </form>

      {isEmpty ? (
        <EmptyState
          message="No service records yet."
          action={<Link href="/service/new">Log first service</Link>}
        />
      ) : records.length === 0 ? (
        <EmptyState
          message="No records match your filters."
          action={<Link href="/service">Clear filters</Link>}
        />
      ) : (
        <ServiceRecordTable records={records} />
      )}
    </div>
  );
}
