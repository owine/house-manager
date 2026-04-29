import type { Vendor } from '@prisma/client';
import Link from 'next/link';

type VendorWithCount = Vendor & { _count: { serviceRecords: number } };

export function VendorTable({ vendors }: { vendors: VendorWithCount[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th className="table-cell">Name</th>
          <th className="table-cell">Kind</th>
          <th className="table-cell">Tags</th>
          <th className="table-cell">Service records</th>
        </tr>
      </thead>
      <tbody>
        {vendors.map((v) => (
          <tr key={v.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td className="table-cell">
              <Link href={`/vendors/${v.id}`}>{v.name}</Link>
            </td>
            <td className="table-cell">{v.kind ?? '—'}</td>
            <td className="table-cell">
              {v.tags.map((t) => (
                <span key={t} className="badge" style={{ marginRight: '0.25rem' }}>
                  {t}
                </span>
              ))}
            </td>
            <td className="table-cell">{v._count.serviceRecords}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
