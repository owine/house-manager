import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { ItemCardGrid } from '@/components/items/ItemCardGrid';
import { ItemListView } from '@/components/items/ItemListView';
import { ItemTable } from '@/components/items/ItemTable';
import { listAllCategories, listAllItemLocations, listItems } from '@/lib/items/queries';
import { parseListParams } from '@/lib/url-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ItemsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') sp.set(k, v);
  }

  const rawView = sp.get('view');
  const initialView = rawView === 'cards' || rawView === 'table' ? rawView : null;

  const params = parseListParams(sp);
  const [{ items, total }, categories, locations] = await Promise.all([
    listItems(params),
    listAllCategories(),
    listAllItemLocations(),
  ]);

  const isEmpty = items.length === 0 && !params.q && !Object.keys(params.filters).length;

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
        <h1>Items ({total})</h1>
        <Link href="/items/new">+ Add item</Link>
      </header>

      {/* Filter form — pure server-side, no JS needed */}
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
        {/* Preserve view param across filter submissions */}
        {initialView && <input type="hidden" name="view" value={initialView} />}

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Search
          <input
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Name, manufacturer, model…"
            style={{
              padding: '0.3rem 0.5rem',
              border: '1px solid var(--border-strong)',
              borderRadius: '4px',
            }}
          />
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Category
          <select
            name="category"
            defaultValue={params.filters.category?.[0] ?? ''}
            style={{
              padding: '0.3rem 0.5rem',
              border: '1px solid var(--border-strong)',
              borderRadius: '4px',
            }}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.icon ? `${c.icon} ` : ''}
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}
        >
          Location
          <select
            name="location"
            defaultValue={params.filters.location?.[0] ?? ''}
            style={{
              padding: '0.3rem 0.5rem',
              border: '1px solid var(--border-strong)',
              borderRadius: '4px',
            }}
          >
            <option value="">All locations</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{
            display: 'flex',
            flexDirection: 'row',
            gap: '0.4rem',
            alignItems: 'center',
            fontSize: '0.85rem',
          }}
        >
          <input
            type="checkbox"
            name="archived"
            value="true"
            defaultChecked={params.filters.archived?.includes('true')}
          />
          Show archived
        </label>

        <button
          type="submit"
          style={{
            padding: '0.3rem 0.75rem',
            borderRadius: '4px',
            border: '1px solid var(--border-strong)',
            cursor: 'pointer',
          }}
        >
          Filter
        </button>

        {(params.q || Object.keys(params.filters).length > 0) && (
          <Link
            href="/items"
            style={{ padding: '0.3rem 0.75rem', fontSize: '0.85rem', alignSelf: 'flex-end' }}
          >
            Clear
          </Link>
        )}
      </form>

      {isEmpty ? (
        <EmptyState
          message="No items yet."
          action={<Link href="/items/new">Add your first item</Link>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          message="No items match your filters."
          action={<Link href="/items">Clear filters</Link>}
        />
      ) : (
        <ItemListView
          initialView={initialView}
          table={<ItemTable items={items} />}
          cards={<ItemCardGrid items={items} />}
        />
      )}
    </div>
  );
}
