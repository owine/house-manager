import Link from 'next/link';

// Structural interface matching Prisma's Decimal for display purposes
interface DecimalLike {
  toNumber(): number;
}

type ServiceRecordRow = {
  id: string;
  performedOn: Date;
  summary: string;
  cost: DecimalLike | null;
  item: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
};

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

export function ServiceRecordTable({ records }: { records: ServiceRecordRow[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th className="table-cell">Date</th>
          <th className="table-cell">Summary</th>
          <th className="table-cell">Item</th>
          <th className="table-cell">Vendor</th>
          <th className="table-cell">Cost</th>
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td className="table-cell" style={{ whiteSpace: 'nowrap' }}>
              <Link href={`/service/${record.id}`}>
                {record.performedOn.toISOString().slice(0, 10)}
              </Link>
            </td>
            <td className="table-cell">
              <Link href={`/service/${record.id}`}>{record.summary}</Link>
            </td>
            <td className="table-cell">
              {record.item ? (
                <Link href={`/items/${record.item.id}`}>{record.item.name}</Link>
              ) : (
                '—'
              )}
            </td>
            <td className="table-cell">
              {record.vendor ? (
                <Link href={`/vendors/${record.vendor.id}`}>{record.vendor.name}</Link>
              ) : (
                '—'
              )}
            </td>
            <td className="table-cell" style={{ whiteSpace: 'nowrap' }}>
              {record.cost != null ? currencyFmt.format(record.cost.toNumber()) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
