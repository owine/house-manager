import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  q: string;
  selectedItemId: string;
  items: Array<{ id: string; name: string }>;
};

export function NotesFilterBar({ q, selectedItemId, items }: Props) {
  const hasFilters = q.length > 0 || selectedItemId.length > 0;

  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-q">Search</label>
        <Input id="filter-q" name="q" defaultValue={q} placeholder="Search title or body…" />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-item">Item</label>
        <select
          id="filter-item"
          name="itemId"
          defaultValue={selectedItemId}
          className="flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">All items</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" variant="outline">
        Filter
      </Button>

      {hasFilters && (
        <Button variant="ghost" render={<Link href="/notes" />}>
          Clear
        </Button>
      )}
    </form>
  );
}
