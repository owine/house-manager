import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  q: string;
  selectedCategorySlug: string;
  selectedLocation: string;
  showArchived: boolean;
  initialView: 'cards' | 'table' | null;
  categories: Array<{ id: string; slug: string; icon: string | null; name: string }>;
  locations: string[];
};

export function ItemsFilterBar({
  q,
  selectedCategorySlug,
  selectedLocation,
  showArchived,
  initialView,
  categories,
  locations,
}: Props) {
  const hasFilters =
    q.length > 0 || selectedCategorySlug.length > 0 || selectedLocation.length > 0 || showArchived;

  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      {initialView && <input type="hidden" name="view" value={initialView} />}

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-q">Search</label>
        <Input id="filter-q" name="q" defaultValue={q} placeholder="Name, manufacturer, model..." />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-category">Category</label>
        <select
          id="filter-category"
          name="category"
          defaultValue={selectedCategorySlug}
          className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.icon ? `${c.icon} ` : ''}
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-location">Location</label>
        <select
          id="filter-location"
          name="location"
          defaultValue={selectedLocation}
          className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">All locations</option>
          {locations.map((loc) => (
            <option key={loc} value={loc}>
              {loc}
            </option>
          ))}
        </select>
      </div>

      <label className="flex flex-row items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          name="archived"
          value="true"
          defaultChecked={showArchived}
          className="h-4 w-4 accent-primary rounded border-input"
        />
        Show archived
      </label>

      <Button type="submit" variant="outline">
        Filter
      </Button>

      {hasFilters && (
        <Button variant="ghost" render={<Link href="/items" />}>
          Clear
        </Button>
      )}
    </form>
  );
}
