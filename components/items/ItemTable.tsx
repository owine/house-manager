import type { Category, Item } from '@prisma/client';
import Link from 'next/link';

type ItemWithRelations = Item & {
  category: Category;
  _count: { warranties: number; serviceRecords: number; itemNotes: number };
};

export function ItemTable({ items }: { items: ItemWithRelations[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr className="table-header">
          <th className="table-cell">Name</th>
          <th className="table-cell">Category</th>
          <th className="table-cell">Location</th>
          <th className="table-cell">Manufacturer / Model</th>
          <th className="table-cell">Warranties</th>
          <th className="table-cell">Service</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="table-row">
            <td className="table-cell">
              <Link href={`/items/${item.id}`}>{item.name}</Link>
            </td>
            <td className="table-cell">
              <span className="badge" style={{ whiteSpace: 'nowrap' }}>
                {item.category.icon ? `${item.category.icon} ` : ''}
                {item.category.name}
              </span>
            </td>
            <td className="table-cell">{item.location ?? '—'}</td>
            <td className="table-cell">
              {[item.manufacturer, item.model].filter(Boolean).join(' / ') || '—'}
            </td>
            <td className="table-cell">{item._count.warranties}</td>
            <td className="table-cell">{item._count.serviceRecords}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
