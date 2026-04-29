import { deleteWarranty } from '@/lib/warranties/actions';
import { WarrantyStatusBadge } from './WarrantyStatusBadge';

// Structural interface matching Prisma's Decimal for display purposes
interface DecimalLike {
  toNumber(): number;
}

type WarrantyRow = {
  id: string;
  provider: string;
  policyNumber: string | null;
  startsOn: Date;
  endsOn: Date;
  cost: DecimalLike | null;
};

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

function WarrantyDeleteForm({ warrantyId }: { warrantyId: string }) {
  async function doDelete() {
    'use server';
    await deleteWarranty(warrantyId);
  }

  return (
    <form action={doDelete}>
      <button
        type="submit"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--danger)',
          font: 'inherit',
        }}
      >
        Delete
      </button>
    </form>
  );
}

export function WarrantyTable({ warranties }: { warranties: WarrantyRow[] }) {
  if (warranties.length === 0) {
    return <p style={{ color: 'var(--fg-muted)' }}>No warranties recorded.</p>;
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr className="table-header">
          <th className="table-cell">Provider</th>
          <th className="table-cell">Policy #</th>
          <th className="table-cell">Starts on</th>
          <th className="table-cell">Ends on</th>
          <th className="table-cell">Status</th>
          <th className="table-cell">Cost</th>
          <th className="table-cell"></th>
        </tr>
      </thead>
      <tbody>
        {warranties.map((warranty) => (
          <tr key={warranty.id} className="table-row">
            <td className="table-cell">{warranty.provider}</td>
            <td className="table-cell">{warranty.policyNumber ?? '—'}</td>
            <td className="table-cell" style={{ whiteSpace: 'nowrap' }}>
              {warranty.startsOn.toISOString().slice(0, 10)}
            </td>
            <td className="table-cell" style={{ whiteSpace: 'nowrap' }}>
              {warranty.endsOn.toISOString().slice(0, 10)}
            </td>
            <td className="table-cell">
              <WarrantyStatusBadge endsOn={warranty.endsOn} />
            </td>
            <td className="table-cell" style={{ whiteSpace: 'nowrap' }}>
              {warranty.cost != null ? currencyFmt.format(warranty.cost.toNumber()) : '—'}
            </td>
            <td className="table-cell">
              <WarrantyDeleteForm warrantyId={warranty.id} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
