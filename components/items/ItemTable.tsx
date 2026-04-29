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
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th style={{ padding: '0.5rem' }}>Name</th>
          <th style={{ padding: '0.5rem' }}>Category</th>
          <th style={{ padding: '0.5rem' }}>Location</th>
          <th style={{ padding: '0.5rem' }}>Manufacturer / Model</th>
          <th style={{ padding: '0.5rem' }}>Warranties</th>
          <th style={{ padding: '0.5rem' }}>Service</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '0.5rem' }}>
              <Link href={`/items/${item.id}`}>{item.name}</Link>
            </td>
            <td style={{ padding: '0.5rem' }}>
              <span
                style={{
                  padding: '0.1rem 0.4rem',
                  background: 'var(--badge-bg)',
                  borderRadius: '4px',
                  fontSize: '0.85rem',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.category.icon ? `${item.category.icon} ` : ''}
                {item.category.name}
              </span>
            </td>
            <td style={{ padding: '0.5rem' }}>{item.location ?? '—'}</td>
            <td style={{ padding: '0.5rem' }}>
              {[item.manufacturer, item.model].filter(Boolean).join(' / ') || '—'}
            </td>
            <td style={{ padding: '0.5rem' }}>{item._count.warranties}</td>
            <td style={{ padding: '0.5rem' }}>{item._count.serviceRecords}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
