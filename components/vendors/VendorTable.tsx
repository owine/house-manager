import type { Vendor } from '@prisma/client';
import Link from 'next/link';

type VendorWithCount = Vendor & { _count: { serviceRecords: number } };

export function VendorTable({ vendors }: { vendors: VendorWithCount[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th style={{ padding: '0.5rem' }}>Name</th>
          <th style={{ padding: '0.5rem' }}>Kind</th>
          <th style={{ padding: '0.5rem' }}>Tags</th>
          <th style={{ padding: '0.5rem' }}>Service records</th>
        </tr>
      </thead>
      <tbody>
        {vendors.map((v) => (
          <tr key={v.id} style={{ borderBottom: '1px solid var(--bg-elevated)' }}>
            <td style={{ padding: '0.5rem' }}>
              <Link href={`/vendors/${v.id}`}>{v.name}</Link>
            </td>
            <td style={{ padding: '0.5rem' }}>{v.kind ?? '—'}</td>
            <td style={{ padding: '0.5rem' }}>
              {v.tags.map((t) => (
                <span
                  key={t}
                  style={{
                    padding: '0.1rem 0.4rem',
                    background: 'var(--badge-bg)',
                    borderRadius: '4px',
                    marginRight: '0.25rem',
                    fontSize: '0.85rem',
                  }}
                >
                  {t}
                </span>
              ))}
            </td>
            <td style={{ padding: '0.5rem' }}>{v._count.serviceRecords}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
