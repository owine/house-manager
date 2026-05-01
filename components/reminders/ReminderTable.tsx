import Link from 'next/link';
import { ReminderStatusBadge } from './ReminderStatusBadge';

type Row = {
  id: string;
  title: string;
  nextDueOn: Date;
  active: boolean;
  item: { id: string; name: string } | null;
};

export function ReminderTable({ reminders }: { reminders: Row[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr className="table-header">
          <th className="table-cell">Title</th>
          <th className="table-cell">Item</th>
          <th className="table-cell">Next due</th>
          <th className="table-cell">Status</th>
        </tr>
      </thead>
      <tbody>
        {reminders.map((r) => (
          <tr key={r.id} className="table-row">
            <td className="table-cell">
              <Link href={`/reminders/${r.id}`}>{r.title}</Link>
            </td>
            <td className="table-cell">
              {r.item ? <Link href={`/items/${r.item.id}`}>{r.item.name}</Link> : '—'}
            </td>
            <td className="table-cell">{r.nextDueOn.toISOString().slice(0, 10)}</td>
            <td className="table-cell">
              <ReminderStatusBadge nextDueOn={r.nextDueOn} active={r.active} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
