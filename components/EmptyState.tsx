type Props = {
  icon?: React.ReactNode;
  message: string;
  action?: React.ReactNode;
};

export function EmptyState({ icon, message, action }: Props) {
  return (
    <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
      {icon && <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>{icon}</div>}
      <p>{message}</p>
      {action && <div style={{ marginTop: '1rem' }}>{action}</div>}
    </div>
  );
}
