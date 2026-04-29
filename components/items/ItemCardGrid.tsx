import type { Category, Item } from '@prisma/client';
import Link from 'next/link';

type ItemWithRelations = Item & {
  category: Category;
  _count: { warranties: number; serviceRecords: number; itemNotes: number };
};

export function ItemCardGrid({ items }: { items: ItemWithRelations[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: '1rem',
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          style={{
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <Link
            href={`/items/${item.id}`}
            style={{ fontWeight: 600, fontSize: '1rem', textDecoration: 'none' }}
          >
            {item.name}
          </Link>
          <span
            style={{
              padding: '0.1rem 0.4rem',
              background: '#eee',
              borderRadius: '4px',
              fontSize: '0.8rem',
              alignSelf: 'flex-start',
              whiteSpace: 'nowrap',
            }}
          >
            {item.category.icon ? `${item.category.icon} ` : ''}
            {item.category.name}
          </span>
          {item.location && (
            <span style={{ fontSize: '0.85rem', color: '#555' }}>{item.location}</span>
          )}
          {item.purchaseDate && (
            <span style={{ fontSize: '0.8rem', color: '#888' }}>
              Purchased: {new Date(item.purchaseDate).toLocaleDateString()}
            </span>
          )}
          <div
            style={{
              marginTop: 'auto',
              display: 'flex',
              gap: '0.75rem',
              fontSize: '0.8rem',
              color: '#666',
            }}
          >
            <span>{item._count.warranties} warranties</span>
            <span>{item._count.serviceRecords} service records</span>
          </div>
        </div>
      ))}
    </div>
  );
}
