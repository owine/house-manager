import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  q: string;
  selectedItemId: string;
  selectedVendorId: string;
  from: string;
  to: string;
  items: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string }>;
};

const selectClass =
  'flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export function ServiceRecordFilterBar({
  q,
  selectedItemId,
  selectedVendorId,
  from,
  to,
  items,
  vendors,
}: Props) {
  const hasFilters =
    q.length > 0 ||
    selectedItemId.length > 0 ||
    selectedVendorId.length > 0 ||
    from.length > 0 ||
    to.length > 0;

  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-q">Search</label>
        <Input id="filter-q" name="q" defaultValue={q} placeholder="Search summary…" />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-item">Item</label>
        <select
          id="filter-item"
          name="itemId"
          defaultValue={selectedItemId}
          className={selectClass}
        >
          <option value="">All items</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-vendor">Vendor</label>
        <select
          id="filter-vendor"
          name="vendorId"
          defaultValue={selectedVendorId}
          className={selectClass}
        >
          <option value="">All vendors</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-from">From</label>
        <Input id="filter-from" type="date" className="w-40" name="from" defaultValue={from} />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="filter-to">To</label>
        <Input id="filter-to" type="date" className="w-40" name="to" defaultValue={to} />
      </div>

      <Button type="submit" variant="outline">
        Filter
      </Button>

      {hasFilters && (
        <Button variant="ghost" render={<Link href="/service" />}>
          Clear
        </Button>
      )}
    </form>
  );
}
