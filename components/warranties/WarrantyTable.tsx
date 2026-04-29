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
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th style={{ padding: '0.5rem' }}>Provider</th>
          <th style={{ padding: '0.5rem' }}>Policy #</th>
          <th style={{ padding: '0.5rem' }}>Starts on</th>
          <th style={{ padding: '0.5rem' }}>Ends on</th>
          <th style={{ padding: '0.5rem' }}>Status</th>
          <th style={{ padding: '0.5rem' }}>Cost</th>
          <th style={{ padding: '0.5rem' }}></th>
        </tr>
      </thead>
      <tbody>
        {warranties.map((warranty) => (
          <tr key={warranty.id} style={{ borderBottom: '1px solid var(--bg-elevated)' }}>
            <td style={{ padding: '0.5rem' }}>{warranty.provider}</td>
            <td style={{ padding: '0.5rem' }}>{warranty.policyNumber ?? '—'}</td>
            <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>
              {warranty.startsOn.toISOString().slice(0, 10)}
            </td>
            <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>
              {warranty.endsOn.toISOString().slice(0, 10)}
            </td>
            <td style={{ padding: '0.5rem' }}>
              <WarrantyStatusBadge endsOn={warranty.endsOn} />
            </td>
            <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>
              {warranty.cost != null ? currencyFmt.format(warranty.cost.toNumber()) : '—'}
            </td>
            <td style={{ padding: '0.5rem' }}>
              <WarrantyDeleteForm warrantyId={warranty.id} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
