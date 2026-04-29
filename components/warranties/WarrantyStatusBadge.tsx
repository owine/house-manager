export function WarrantyStatusBadge({ endsOn }: { endsOn: Date }) {
  const days = (endsOn.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days < 0) return <span style={{ color: '#999' }}>expired</span>;
  if (days < 60) return <span style={{ color: '#c80' }}>expiring soon</span>;
  return <span style={{ color: '#080' }}>active</span>;
}
