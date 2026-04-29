export function WarrantyStatusBadge({ endsOn }: { endsOn: Date }) {
  const days = (endsOn.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days < 0) return <span style={{ color: 'var(--fg-muted)' }}>expired</span>;
  if (days < 60) return <span style={{ color: 'var(--warning)' }}>expiring soon</span>;
  return <span style={{ color: 'var(--success)' }}>active</span>;
}
