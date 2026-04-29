import Link from 'next/link';

export type TabSlug = 'overview' | 'warranties' | 'service' | 'notes';

const TABS: { slug: TabSlug; label: string }[] = [
  { slug: 'overview', label: 'Overview' },
  { slug: 'warranties', label: 'Warranties' },
  { slug: 'service', label: 'Service' },
  { slug: 'notes', label: 'Notes' },
];

type Props = {
  active: TabSlug;
  itemId: string;
};

export function ItemTabs({ active, itemId }: Props) {
  return (
    <nav
      style={{
        display: 'flex',
        gap: '0',
        borderBottom: '1px solid #ddd',
        marginBottom: '1.5rem',
      }}
    >
      {TABS.map(({ slug, label }) => {
        const isActive = slug === active;
        return (
          <Link
            key={slug}
            href={`/items/${itemId}?tab=${slug}`}
            style={{
              padding: '0.5rem 1rem',
              textDecoration: 'none',
              fontSize: '0.9rem',
              color: isActive ? '#000' : '#555',
              fontWeight: isActive ? 600 : 400,
              borderBottom: isActive ? '2px solid #000' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
